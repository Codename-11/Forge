import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { EventKind, NoteKind, Priority } from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";

/**
 * Compute "today's date" (UTC midnight) anchored in the user's
 * timezone. The journalDate column is stored as UTC midnight; what
 * varies per user is which UTC midnight counts as "today" given their
 * wall-clock day. Falls back to the server's UTC midnight when no
 * timezone is set (matches the schema default).
 */
function todayUtcMidnightForTimezone(tz: string | null): Date {
  const now = new Date();
  if (!tz) {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
  // Use Intl.DateTimeFormat to get the wall-clock Y/M/D in the
  // requested zone, then build a UTC midnight on that date. This
  // intentionally normalises to UTC midnight (NOT local midnight)
  // so the unique constraint behaves the same regardless of DST.
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const [y, m, d] = fmt.format(now).split("-").map((p) => parseInt(p, 10));
    const out = new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
    return out;
  } catch {
    // Bad timezone string — fall back to UTC.
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return d;
  }
}

/**
 * Quick Notes — per-user markdown scratchpad surfaced on the dashboard.
 *
 * Notes are intentionally personal (per-user, per-workspace) rather than
 * shared: this is the surface for fast capture (TODO threads, reasoning
 * scratchpads, agent notes-to-self). Sharing happens by `convertToIssue`,
 * which spawns a real Issue and leaves the source note intact so the user
 * can archive it on their own schedule.
 *
 * Ordering: pinned notes float to the top, then most-recently-updated.
 * Soft-delete via `archivedAt`; hard `delete` is rare (kept for cleanup).
 *
 * MCP namespace `notes.*` (in `src/server/services/mcp.ts`) mirrors the
 * read/write surface so agents can leave themselves notes.
 */

export const noteRouter = router({
  /**
   * List the caller's notes in this workspace. Defaults to non-archived,
   * NOTE-kind only; pass `{ archived: true }` to list archived rows or
   * `{ kind: "JOURNAL" }` to list journal entries (though most consumers
   * should use `note.listJournal` for that).
   */
  list: workspaceProcedure
    .input(
      z.object({
        archived: z.boolean().default(false),
        kind: z.nativeEnum(NoteKind).default(NoteKind.NOTE),
        limit: z.number().int().positive().max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.note.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          kind: input.kind,
          archivedAt: input.archived ? { not: null } : null,
        },
        orderBy: [{ pinned: "desc" }, { updatedAt: "desc" }],
        take: input.limit,
      });
      return { items: rows };
    }),

  /** Create a new note for the calling user. */
  create: workspaceProcedure
    .input(
      z.object({
        title: z.string().max(200).optional(),
        body: z.string().min(1).max(50_000),
        pinned: z.boolean().default(false),
        kind: z.nativeEnum(NoteKind).default(NoteKind.NOTE),
        /**
         * Required when `kind = JOURNAL`. Ignored otherwise. UTC
         * midnight is recommended; callers that need timezone-aware
         * "today" should use `note.todayJournal` instead which does
         * the normalisation.
         */
        journalDate: z.coerce.date().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.note.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          title: input.title?.trim() || null,
          body: input.body,
          pinned: input.pinned,
          kind: input.kind,
          journalDate:
            input.kind === NoteKind.JOURNAL
              ? input.journalDate ?? new Date()
              : null,
        },
      });
      return note;
    }),

  /**
   * Get-or-create today's journal entry for the caller. Date is
   * "today" in the caller's timezone (User.timezone) — falls back to
   * UTC midnight when null. Idempotent: subsequent calls on the same
   * day return the existing row. Empty body on first creation so the
   * UI can immediately render an editable card.
   */
  todayJournal: workspaceProcedure.mutation(async ({ ctx }) => {
    const me = await ctx.db.user.findUniqueOrThrow({
      where: { id: ctx.session.user.id },
      select: { timezone: true },
    });
    const today = todayUtcMidnightForTimezone(me.timezone);

    const existing = await ctx.db.note.findFirst({
      where: {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        kind: NoteKind.JOURNAL,
        journalDate: today,
      },
    });
    if (existing) return existing;
    return ctx.db.note.create({
      data: {
        workspaceId: ctx.workspaceId,
        userId: ctx.session.user.id,
        kind: NoteKind.JOURNAL,
        journalDate: today,
        title: null,
        body: "",
      },
    });
  }),

  /**
   * List recent journal entries for the caller, ordered by
   * `journalDate desc`. Default window is 30 entries (≈one month).
   */
  listJournal: workspaceProcedure
    .input(
      z.object({
        from: z.coerce.date().optional(),
        to: z.coerce.date().optional(),
        limit: z.number().int().positive().max(180).default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db.note.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          kind: NoteKind.JOURNAL,
          ...(input.from || input.to
            ? {
                journalDate: {
                  ...(input.from ? { gte: input.from } : {}),
                  ...(input.to ? { lte: input.to } : {}),
                },
              }
            : {}),
        },
        orderBy: { journalDate: "desc" },
        take: input.limit,
      });
      return { items: rows };
    }),

  /** Patch fields on a note the caller owns. */
  update: workspaceProcedure
    .input(
      z.object({
        id: z.string(),
        title: z.string().max(200).nullable().optional(),
        // Allow empty body for journal entries that were created blank
        // and edited later. NOTE-kind rows enforce min(1) at create time;
        // an explicit clear via update is rare but harmless.
        body: z.string().max(50_000).optional(),
        pinned: z.boolean().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.note.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
      }
      const note = await ctx.db.note.update({
        where: { id: existing.id },
        data: {
          ...(input.title !== undefined
            ? { title: input.title === null ? null : input.title.trim() || null }
            : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
        },
      });
      return note;
    }),

  /** Soft-archive — bumps it out of the default list. */
  archive: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.note.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
      }
      return ctx.db.note.update({
        where: { id: existing.id },
        data: { archivedAt: new Date() },
      });
    }),

  /** Reverse `archive`. */
  unarchive: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.note.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
      }
      return ctx.db.note.update({
        where: { id: existing.id },
        data: { archivedAt: null },
      });
    }),

  /** Hard-delete. Prefer `archive` — this is the cleanup path. */
  delete: workspaceProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.db.note.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
      }
      await ctx.db.note.delete({ where: { id: existing.id } });
      return { ok: true as const };
    }),

  /**
   * Spawn a new Issue from this note. Title = note.title || first line of
   * body; description = body. The source note is left in place — the user
   * can archive it separately if they want it out of the widget.
   */
  convertToIssue: workspaceProcedure
    .input(
      z.object({
        id: z.string(),
        projectId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.note.findFirst({
        where: {
          id: input.id,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!note) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
      }
      const fallbackTitle = note.body.split("\n")[0]?.trim() || "Untitled note";
      const title = (note.title?.trim() || fallbackTitle).slice(0, 300);

      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { key: true },
      });

      const issue = await ctx.db.$transaction(async (tx) => {
        const status = await tx.status.findFirstOrThrow({
          where: { workspaceId: ctx.workspaceId, isDefault: true },
        });
        const last = await tx.issue.findFirst({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        const number = (last?.number ?? 0) + 1;
        const created = await tx.issue.create({
          data: {
            workspaceId: ctx.workspaceId,
            number,
            title,
            description: note.body,
            projectId: input.projectId,
            statusId: status.id,
            priority: Priority.NONE,
            authorId: ctx.session.user.id,
          },
          include: { status: true },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          entity: "Issue",
          entityId: created.id,
          action: "create",
          after: created,
          eventKind: EventKind.ISSUE_CREATED,
          subjectType: "issue",
          subjectId: created.id,
          payload: {
            number: created.number,
            title: created.title,
            from: "note",
            noteId: note.id,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      });

      return {
        issueId: issue.id,
        issueKey: `${ws.key}-${issue.number}`,
        number: issue.number,
      };
    }),
});
