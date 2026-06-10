import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  EventKind,
  InitiativeStatus,
  NoteKind,
  NoteStatus,
  Priority,
} from "@prisma/client";
import { router, workspaceProcedure } from "@/server/trpc";
import { recordChange } from "@/server/audit";
import { resolveDefaultIssueAssigneeIds } from "@/server/services/issue-create";
import { autoWatchUser } from "@/server/services/issue-watchers";

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
   *
   * Optional filters:
   *   - `status` — single NoteStatus or array. Drives the dashboard chip
   *     row (IDEA | SOMEDAY | ACTIVE | ARCHIVED).
   *   - `pinned` — when set, restricts to pinned rows.
   *   - `search` — case-insensitive substring on title + body.
   */
  list: workspaceProcedure
    .input(
      z.object({
        archived: z.boolean().default(false),
        kind: z.nativeEnum(NoteKind).default(NoteKind.NOTE),
        status: z
          .union([z.nativeEnum(NoteStatus), z.array(z.nativeEnum(NoteStatus))])
          .optional(),
        pinned: z.boolean().optional(),
        search: z.string().trim().max(200).optional(),
        limit: z.number().int().positive().max(100).default(20),
      }),
    )
    .query(async ({ ctx, input }) => {
      const statusFilter =
        input.status === undefined
          ? undefined
          : Array.isArray(input.status)
            ? input.status.length > 0
              ? { in: input.status }
              : undefined
            : input.status;
      const search = input.search?.trim();
      const rows = await ctx.db.note.findMany({
        where: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          kind: input.kind,
          archivedAt: input.archived ? { not: null } : null,
          ...(statusFilter !== undefined ? { status: statusFilter } : {}),
          ...(input.pinned !== undefined ? { pinned: input.pinned } : {}),
          ...(search
            ? {
                OR: [
                  { title: { contains: search, mode: "insensitive" as const } },
                  { body: { contains: search, mode: "insensitive" as const } },
                ],
              }
            : {}),
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
         * Lifecycle status — defaults to IDEA for NOTE-kind (fresh
         * capture) and ACTIVE for JOURNAL-kind (durable record, not a
         * pitch). Override only when the caller has a reason to skip
         * the default capture state.
         */
        status: z.nativeEnum(NoteStatus).optional(),
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
      const status =
        input.status ??
        (input.kind === NoteKind.JOURNAL ? NoteStatus.ACTIVE : NoteStatus.IDEA);
      const note = await ctx.db.note.create({
        data: {
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
          title: input.title?.trim() || null,
          body: input.body,
          pinned: input.pinned,
          kind: input.kind,
          status,
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
        const assigneeIds = await resolveDefaultIssueAssigneeIds(tx, {
          workspaceId: ctx.workspaceId,
          authorId: ctx.session.user.id,
        });
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
            sourceNoteId: note.id,
            assignees: {
              create: assigneeIds.map((userId) => ({ userId })),
            },
          },
          include: { status: true },
        });
        for (const userId of assigneeIds) {
          await autoWatchUser(tx, {
            workspaceId: ctx.workspaceId,
            issueId: created.id,
            userId,
          });
        }
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
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

  /**
   * Flip a note between lifecycle states (IDEA → SOMEDAY → ACTIVE →
   * ARCHIVED). Status is orthogonal to `archivedAt`: the archive timestamp
   * is the soft-delete tier the widget uses, while `status = ARCHIVED`
   * drives the dashboard chip row. Most flows transition through status
   * (chip click) — `archivedAt` flips via the existing `archive`
   * mutation.
   */
  setStatus: workspaceProcedure
    .input(
      z.object({
        noteId: z.string(),
        status: z.nativeEnum(NoteStatus),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.db.$transaction(async (tx) => {
        const before = await tx.note.findFirst({
          where: {
            id: input.noteId,
            workspaceId: ctx.workspaceId,
            userId: ctx.session.user.id,
          },
        });
        if (!before) {
          throw new TRPCError({
            code: "NOT_FOUND",
            message: "Note not found.",
          });
        }
        if (before.status === input.status) return before;
        const after = await tx.note.update({
          where: { id: before.id },
          data: { status: input.status },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Note",
          entityId: before.id,
          action: "status.set",
          before: { status: before.status },
          after: { status: after.status },
          eventKind: EventKind.PROJECT_UPDATED,
          subjectType: "note",
          subjectId: before.id,
          payload: { status: after.status },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return after;
      });
    }),

  /**
   * Promote a note into a downstream entity (Issue / Project / Initiative).
   * The downstream row carries `sourceNoteId` back to the note, and the
   * note records `promotedToType` + `promotedToId` and transitions to
   * `ACTIVE`. The source note is left in place — the user can archive
   * it separately.
   *
   * Title defaults: `note.title` → first non-empty line of body →
   * "Untitled note". Bodies are inherited as the downstream description.
   */
  promote: workspaceProcedure
    .input(
      z.object({
        noteId: z.string(),
        kind: z.enum(["issue", "project", "initiative"]),
        title: z.string().min(1).max(300).optional(),
        projectId: z.string().cuid().optional(),
        initiativeId: z.string().cuid().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const note = await ctx.db.note.findFirst({
        where: {
          id: input.noteId,
          workspaceId: ctx.workspaceId,
          userId: ctx.session.user.id,
        },
      });
      if (!note) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Note not found." });
      }

      const fallbackTitle =
        note.body.split("\n").find((l) => l.trim())?.trim() || "Untitled note";
      const title = (input.title?.trim() || note.title?.trim() || fallbackTitle).slice(
        0,
        300,
      );
      const description = note.body;

      const ws = await ctx.db.workspace.findUniqueOrThrow({
        where: { id: ctx.workspaceId },
        select: { key: true },
      });

      if (input.kind === "issue") {
        const result = await ctx.db.$transaction(async (tx) => {
          const status = await tx.status.findFirstOrThrow({
            where: { workspaceId: ctx.workspaceId, isDefault: true },
          });
          const last = await tx.issue.findFirst({
            where: { workspaceId: ctx.workspaceId },
            orderBy: { number: "desc" },
            select: { number: true },
          });
          const number = (last?.number ?? 0) + 1;
          const assigneeIds = await resolveDefaultIssueAssigneeIds(tx, {
            workspaceId: ctx.workspaceId,
            authorId: ctx.session.user.id,
          });
          const issue = await tx.issue.create({
            data: {
              workspaceId: ctx.workspaceId,
              number,
              title,
              description,
              projectId: input.projectId,
              statusId: status.id,
              priority: Priority.NONE,
              authorId: ctx.session.user.id,
              sourceNoteId: note.id,
              assignees: {
                create: assigneeIds.map((userId) => ({ userId })),
              },
            },
            include: { status: true },
          });
          for (const userId of assigneeIds) {
            await autoWatchUser(tx, {
              workspaceId: ctx.workspaceId,
              issueId: issue.id,
              userId,
            });
          }
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Issue",
            entityId: issue.id,
            action: "create",
            after: issue,
            eventKind: EventKind.ISSUE_CREATED,
            subjectType: "issue",
            subjectId: issue.id,
            payload: {
              number: issue.number,
              title: issue.title,
              from: "note",
              noteId: note.id,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          const updatedNote = await tx.note.update({
            where: { id: note.id },
            data: {
              status: NoteStatus.ACTIVE,
              promotedToType: "issue",
              promotedToId: issue.id,
            },
          });
          return { issue, updatedNote };
        });
        return {
          note: result.updatedNote,
          target: {
            kind: "issue" as const,
            id: result.issue.id,
            number: result.issue.number,
            key: `${ws.key}-${result.issue.number}`,
            title: result.issue.title,
          },
        };
      }

      if (input.kind === "project") {
        const projectKey = generateProjectKey(title);
        const result = await ctx.db.$transaction(async (tx) => {
          const uniqueKey = await ensureUniqueProjectKey(tx, ctx.workspaceId, projectKey);
          const project = await tx.project.create({
            data: {
              workspaceId: ctx.workspaceId,
              key: uniqueKey,
              name: title,
              description,
              initiativeId: input.initiativeId,
              createdById: ctx.session.user.id,
              sourceNoteId: note.id,
            },
          });
          await recordChange(tx, {
            workspaceId: ctx.workspaceId,
            actorId: ctx.session.user.id,
            actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
            entity: "Project",
            entityId: project.id,
            action: "create",
            after: project,
            eventKind: EventKind.PROJECT_CREATED,
            subjectType: "project",
            subjectId: project.id,
            payload: {
              name: project.name,
              key: project.key,
              from: "note",
              noteId: note.id,
            },
            ip: ctx.ip,
            userAgent: ctx.userAgent,
          });
          const updatedNote = await tx.note.update({
            where: { id: note.id },
            data: {
              status: NoteStatus.ACTIVE,
              promotedToType: "project",
              promotedToId: project.id,
            },
          });
          return { project, updatedNote };
        });
        return {
          note: result.updatedNote,
          target: {
            kind: "project" as const,
            id: result.project.id,
            key: result.project.key,
            title: result.project.name,
          },
        };
      }

      // initiative
      const slug = slugifyInitiative(title);
      const result = await ctx.db.$transaction(async (tx) => {
        const uniqueSlug = await ensureUniqueInitiativeSlug(
          tx,
          ctx.workspaceId,
          slug,
        );
        const last = await tx.initiative.findFirst({
          where: { workspaceId: ctx.workspaceId },
          orderBy: { position: "desc" },
          select: { position: true },
        });
        const initiative = await tx.initiative.create({
          data: {
            workspaceId: ctx.workspaceId,
            name: title,
            slug: uniqueSlug,
            description,
            status: InitiativeStatus.PLANNED,
            position: (last?.position ?? -1) + 1,
            createdById: ctx.session.user.id,
            sourceNoteId: note.id,
          },
        });
        await recordChange(tx, {
          workspaceId: ctx.workspaceId,
          actorId: ctx.session.user.id,
          actorAgentId: ctx.apiKey?.linkedAgentId ?? null,
          entity: "Initiative",
          entityId: initiative.id,
          action: "create",
          after: initiative,
          eventKind: EventKind.PROJECT_CREATED,
          subjectType: "initiative",
          subjectId: initiative.id,
          payload: {
            name: initiative.name,
            slug: initiative.slug,
            from: "note",
            noteId: note.id,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        const updatedNote = await tx.note.update({
          where: { id: note.id },
          data: {
            status: NoteStatus.ACTIVE,
            promotedToType: "initiative",
            promotedToId: initiative.id,
          },
        });
        return { initiative, updatedNote };
      });
      return {
        note: result.updatedNote,
        target: {
          kind: "initiative" as const,
          id: result.initiative.id,
          slug: result.initiative.slug,
          title: result.initiative.name,
        },
      };
    }),
});

// ---------------------------------------------------------------------------
// Promote helpers — keep the key/slug generation local to the note router so
// the project/initiative routers stay the source of truth for their own
// validators. Both helpers fall back to a numeric suffix on collision rather
// than throwing, since `notes.promote` is a one-click affordance and the
// operator can rename the downstream entity after the fact.
// ---------------------------------------------------------------------------

function generateProjectKey(title: string): string {
  const stripped = title
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (stripped.length === 0) return "PRJ";
  let key: string;
  if (stripped.length === 1) {
    key = stripped[0].slice(0, 4);
  } else {
    key = stripped
      .slice(0, 4)
      .map((w) => w[0])
      .join("");
  }
  key = key.replace(/[^A-Z0-9]/g, "").slice(0, 8);
  if (key.length < 2) key = (key + "PRJ").slice(0, 4);
  return key;
}

async function ensureUniqueProjectKey(
  tx: {
    project: {
      findFirst: (args: {
        where: { workspaceId: string; key: string };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  workspaceId: string,
  baseKey: string,
): Promise<string> {
  let candidate = baseKey;
  let suffix = 2;
  // Cap the loop so a worst-case collision storm can't spin forever; 99
  // attempts is well past anything a real workspace would see.
  for (let i = 0; i < 100; i++) {
    const existing = await tx.project.findFirst({
      where: { workspaceId, key: candidate },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${baseKey.slice(0, 6)}${suffix}`;
    suffix += 1;
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "Could not generate a unique project key — set one manually.",
  });
}

function slugifyInitiative(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || "initiative"
  );
}

async function ensureUniqueInitiativeSlug(
  tx: {
    initiative: {
      findUnique: (args: {
        where: { workspaceId_slug: { workspaceId: string; slug: string } };
        select: { id: true };
      }) => Promise<{ id: string } | null>;
    };
  },
  workspaceId: string,
  baseSlug: string,
): Promise<string> {
  let candidate = baseSlug;
  let suffix = 2;
  for (let i = 0; i < 100; i++) {
    const existing = await tx.initiative.findUnique({
      where: { workspaceId_slug: { workspaceId, slug: candidate } },
      select: { id: true },
    });
    if (!existing) return candidate;
    candidate = `${baseSlug.slice(0, 44)}-${suffix}`;
    suffix += 1;
  }
  throw new TRPCError({
    code: "CONFLICT",
    message: "Could not generate a unique initiative slug — set one manually.",
  });
}
