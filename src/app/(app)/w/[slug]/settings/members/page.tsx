"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronRight, Send, Users, X } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Kbd } from "@/components/ui/kbd";
import { Confirm } from "@/components/ui/modal";
import { CenterModal } from "@/components/ui/modal/center-modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/ui";
import { cn } from "@/lib/utils";
import { trpc } from "@/lib/trpc";
import { initials, relativeTime } from "@/lib/utils";

/**
 * Workspace members settings — admin-gated.
 *
 * Authelia owns identity; email-based self-service invites don't make
 * sense behind SSO. This page is the one place to grant access by email
 * (creates a `Membership` that will bind whenever Authelia lets that
 * email through), flip roles inline, or remove members. All mutations
 * route through `adminProcedure` so non-admins hit a FORBIDDEN even if
 * they guess the URL.
 */
const ROLES = ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const;
type Role = (typeof ROLES)[number];

const ROLE_HELP: { role: Role; blurb: string }[] = [
  {
    role: "OWNER",
    blurb:
      "Full control, including workspace deletion and ownership transfer. There is always at least one owner.",
  },
  {
    role: "ADMIN",
    blurb:
      "Manage members, roles, agents, and workspace settings. Cannot delete the workspace.",
  },
  {
    role: "MEMBER",
    blurb:
      "Create and work issues, projects, and sprints. The default for most teammates.",
  },
  {
    role: "GUEST",
    blurb:
      "Read-mostly access for external collaborators — scoped to what they're explicitly granted.",
  },
];

const ROLE_BLURB: Record<Role, string> = Object.fromEntries(
  ROLE_HELP.map((r) => [r.role, r.blurb]),
) as Record<Role, string>;

/** Roles an admin can hand out via invite. OWNER is special (transfer-only). */
const INVITE_ROLES = ["ADMIN", "MEMBER", "GUEST"] as const satisfies readonly Role[];

// Permissive-but-real email shape. Mirrors the server's `z.string().email()`
// closely enough to flag obvious typos client-side without false rejects.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ChipStatus = "ready" | "exists" | "invalid";
type Chip = { email: string; status: ChipStatus };

/**
 * Parse a raw recipients blob into de-duped, validated chips. Splits on
 * commas, whitespace, and newlines; lowercases for both de-dup and the
 * already-a-member check (membership emails are stored lowercased).
 */
function parseRecipients(raw: string, memberEmails: Set<string>): Chip[] {
  const seen = new Set<string>();
  const chips: Chip[] = [];
  for (const tokenRaw of raw.split(/[\s,]+/)) {
    const email = tokenRaw.trim().toLowerCase();
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    const status: ChipStatus = !EMAIL_RE.test(email)
      ? "invalid"
      : memberEmails.has(email)
        ? "exists"
        : "ready";
    chips.push({ email, status });
  }
  return chips;
}

export default function MembersPage() {
  const utils = trpc.useUtils();
  const { data: members, refetch, isLoading } =
    trpc.workspace.listMembers.useQuery();
  const { data: me } = trpc.workspace.me.useQuery();
  const { data: workspace } = trpc.workspace.current.useQuery();
  const [removeTarget, setRemoveTarget] = useState<{
    userId: string;
    email: string;
  } | null>(null);

  // ── Invite composer state ──────────────────────────────────────────
  const [inviteOpen, setInviteOpen] = useState(false);
  const [recipientsRaw, setRecipientsRaw] = useState("");
  const [inviteRole, setInviteRole] = useState<Role>("MEMBER");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);

  // Lowercased roster emails — the client-side "already a member" oracle.
  const memberEmails = useMemo(
    () => new Set((members ?? []).map((m) => m.email.toLowerCase())),
    [members],
  );
  const chips = useMemo(
    () => parseRecipients(recipientsRaw, memberEmails),
    [recipientsRaw, memberEmails],
  );
  const readyChips = chips.filter((c) => c.status === "ready");
  const existsCount = chips.filter((c) => c.status === "exists").length;
  const invalidCount = chips.filter((c) => c.status === "invalid").length;
  const readyCount = readyChips.length;

  function removeChip(email: string) {
    // Rebuild the raw string without the removed token, preserving the rest.
    const next = chips.filter((c) => c.email !== email).map((c) => c.email);
    setRecipientsRaw(next.join(", "));
  }

  function resetComposer() {
    setRecipientsRaw("");
    setInviteRole("MEMBER");
    setNote("");
  }

  const addMember = trpc.workspace.addMember.useMutation();

  /**
   * Send one invite per ready recipient by looping the existing
   * single-email `addMember` mutation (no bulk endpoint exists — by
   * design). Fired in parallel; we tally created vs. already-existing
   * vs. failed from the settled results, toast a summary, then refetch.
   */
  async function sendInvites() {
    if (readyCount === 0 || sending) return;
    setSending(true);
    try {
      const results = await Promise.allSettled(
        readyChips.map((c) =>
          addMember.mutateAsync({ email: c.email, role: inviteRole }),
        ),
      );
      let invited = 0;
      let skipped = 0;
      let failed = 0;
      for (const r of results) {
        if (r.status === "rejected") failed += 1;
        else if (r.value.created) invited += 1;
        else skipped += 1;
      }
      const parts: string[] = [];
      if (invited) parts.push(`Invited ${invited}`);
      if (skipped) parts.push(`skipped ${skipped} existing`);
      if (failed) parts.push(`${failed} failed`);
      const summary = parts.join(" · ") || "Nothing to send.";
      if (failed && !invited) toast.error(summary);
      else toast.success(summary);

      await utils.workspace.listMembers.invalidate();
      if (!failed) {
        setInviteOpen(false);
        resetComposer();
      }
    } finally {
      setSending(false);
    }
  }

  const setMemberRole = trpc.workspace.setMemberRole.useMutation({
    onSuccess: () => {
      toast.success("Role updated.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const removeMember = trpc.workspace.removeMember.useMutation({
    onSuccess: () => {
      toast.success("Member removed.");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <>
      <Topbar
        title="Members"
        subtitle="Admin-gated access. Authelia owns identity — this is the one place to grant access by email."
        actions={
          <Button variant="ember" size="sm" onClick={() => setInviteOpen(true)}>
            Invite members
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
          <Section
            title="Roster"
            hint="Email-based access. A member binds to a real identity on first SSO login; until then they hold their assigned role in waiting."
            actions={
              members && members.length > 0 ? (
                <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
                  {members.length} member{members.length === 1 ? "" : "s"}
                </span>
              ) : undefined
            }
          >
            {!isLoading && members?.length === 0 ? (
              <EmptyState
                as="div"
                icon={Users}
                title="No members yet"
                hint="Members are people who can sign in to this workspace. Add a teammate by email and they'll bind to their account on first SSO login — then change their role any time."
                action={
                  <Button variant="ember" size="sm" onClick={() => setInviteOpen(true)}>
                    Invite your first member
                  </Button>
                }
              />
            ) : (
              <Card>
                {(members ?? []).map((m) => {
                  const isSelf = me?.user.id === m.userId;
                  return (
                    <li
                      key={m.membershipId}
                      className="grid grid-cols-[2rem_minmax(0,1fr)] gap-3 px-4 py-3 hover:bg-subtle/40 sm:flex sm:flex-wrap sm:items-center"
                    >
                      <div className="flex h-8 w-8 items-center justify-center rounded-full bg-subtle text-xs font-medium text-muted-foreground">
                        {initials(m.name ?? m.email)}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="truncate text-sm font-medium text-foreground">
                            {m.name ?? m.email}
                          </div>
                          {isSelf && <Badge>you</Badge>}
                        </div>
                        <div className="truncate text-[0.6875rem] text-muted-foreground">
                          <span className="font-mono">{m.email}</span>
                          {m.handle && (
                            <>
                              {" "}
                              · <span className="font-mono">@{m.handle}</span>
                            </>
                          )}
                          {" "}· joined {relativeTime(m.joinedAt)}
                        </div>
                      </div>
                      <div className="col-span-2 sm:col-span-1">
                        <Combobox
                          value={m.role}
                          disabled={setMemberRole.isPending}
                          onChange={(v) =>
                            v && setMemberRole.mutate({ userId: m.userId, role: v as Role })
                          }
                          options={ROLES.map((r) => ({
                            value: r,
                            label: r.charAt(0) + r.slice(1).toLowerCase(),
                          }))}
                          matchTriggerWidth
                          ariaLabel={`Role for ${m.email}`}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={removeMember.isPending}
                        onClick={() =>
                          setRemoveTarget({ userId: m.userId, email: m.email })
                        }
                        className="col-span-2 sm:col-span-1"
                      >
                        Remove
                      </Button>
                    </li>
                  );
                })}
              </Card>
            )}
          </Section>

          <Section
            title="Roles"
            hint="What each role can do in this workspace. Change a member's role from the dropdown on their row."
          >
            <Card as="div" className="divide-y divide-border">
              {ROLE_HELP.map((r) => (
                <div key={r.role} className="flex gap-3 px-4 py-3">
                  <span className="mt-px w-16 shrink-0 font-mono text-[0.6875rem] uppercase tracking-wider text-foreground">
                    {r.role}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {r.blurb}
                  </span>
                </div>
              ))}
            </Card>
          </Section>
        </div>
      </div>

      <CenterModal
        open={inviteOpen}
        onOpenChange={(v) => {
          setInviteOpen(v);
          if (!v) resetComposer();
        }}
        size="md"
        title="Invite members"
        description="Authelia owns identity — invitees sign in with their existing SSO account on first visit."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-[0.6875rem] text-muted-foreground">
              {readyCount === 0
                ? "Add at least one valid email"
                : `${readyCount} invite${readyCount === 1 ? "" : "s"} will be sent`}{" "}
              · <Kbd>⌘⏎</Kbd> send
            </span>
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={sending}
                onClick={() => {
                  setInviteOpen(false);
                  resetComposer();
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="ember"
                size="sm"
                disabled={sending || readyCount === 0}
                onClick={sendInvites}
              >
                <Send className="h-3.5 w-3.5" />
                {sending
                  ? "Sending…"
                  : `Send ${readyCount} invite${readyCount === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        }
      >
        <div
          className="space-y-6"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void sendInvites();
            }
          }}
        >
          {/* Recipients ──────────────────────────────────────────── */}
          <Section
            title="Recipients"
            hint="Comma, space, or newline-separated. We'll de-dupe and skip people already in this workspace."
          >
            <div className="space-y-2">
              <div className="flex min-h-[58px] flex-wrap items-center gap-1.5 rounded-md border border-input bg-background p-2">
                {chips.map((c) => (
                  <span
                    key={c.email}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[0.6875rem]",
                      c.status === "exists" &&
                        "border-warning/40 bg-warning/10 text-warning",
                      c.status === "invalid" &&
                        "border-danger/40 bg-danger/10 text-danger",
                      c.status === "ready" &&
                        "border-border bg-background text-foreground",
                    )}
                  >
                    <span className="font-mono">{c.email}</span>
                    {c.status === "exists" && (
                      <span className="text-[10px]">already a member</span>
                    )}
                    {c.status === "invalid" && (
                      <span className="text-[10px]">invalid</span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${c.email}`}
                      onClick={() => removeChip(c.email)}
                      className={cn(
                        "hover:opacity-70",
                        c.status === "ready" && "text-muted-foreground",
                      )}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
                <textarea
                  rows={1}
                  autoFocus
                  value={recipientsRaw}
                  onChange={(e) => setRecipientsRaw(e.target.value)}
                  placeholder={chips.length === 0 ? "teammate@example.com, …" : "add another email…"}
                  aria-label="Recipient emails"
                  className="min-w-0 flex-1 resize-none bg-transparent text-sm text-foreground placeholder:text-muted-foreground focus:outline-none sm:min-w-[160px]"
                />
              </div>
              {chips.length > 0 && (
                <div className="flex items-center gap-3 text-[0.6875rem] text-muted-foreground">
                  <span>{readyCount} ready</span>
                  {existsCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-warning">
                        {existsCount} already {existsCount === 1 ? "a member" : "members"}
                      </span>
                    </>
                  )}
                  {invalidCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-danger">{invalidCount} invalid</span>
                    </>
                  )}
                </div>
              )}
            </div>
          </Section>

          {/* Role ────────────────────────────────────────────────── */}
          <Section title="Role" hint="You can change per-member roles after they accept.">
            <div className="rounded-md border border-border bg-background p-3">
              <div
                role="radiogroup"
                aria-label="Invite role"
                className="inline-flex flex-wrap rounded-md border border-border bg-card/40 p-0.5"
              >
                {INVITE_ROLES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="radio"
                    aria-checked={inviteRole === r}
                    onClick={() => setInviteRole(r)}
                    className={cn(
                      "rounded px-3 py-1 text-xs font-medium transition-colors",
                      inviteRole === r
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {r.charAt(0) + r.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[0.6875rem] text-muted-foreground">
                <span className="font-medium text-foreground">
                  {inviteRole.charAt(0) + inviteRole.slice(1).toLowerCase()}
                </span>{" "}
                · {ROLE_BLURB[inviteRole]}
              </p>
            </div>
          </Section>

          {/* Optional note ───────────────────────────────────────── */}
          <Section
            title="Optional note"
            hint="Appears in the invite email. Markdown supported."
          >
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="focus-ring w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground"
              placeholder="Hey — added you to our Forge workspace. We're using it for sprint planning + agent dispatch."
            />
          </Section>

          {/* Preview email ───────────────────────────────────────── */}
          <details className="group rounded-md border border-border bg-card/40">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              Preview email
            </summary>
            <div className="border-t border-border/60 bg-background px-4 py-3 text-[0.6875rem] text-muted-foreground">
              <div>
                <span className="text-foreground">From</span> · Forge
                &lt;no-reply@forge.local&gt;
              </div>
              <div className="mt-0.5">
                <span className="text-foreground">Subject</span> ·{" "}
                {me?.user.name ?? me?.user.email ?? "An admin"} invited you to
                {workspace?.name ? ` "${workspace.name}"` : " your workspace"} on Forge
              </div>
              <div className="mt-2 rounded-md border border-border bg-card/30 p-3 text-sm leading-relaxed text-foreground/90">
                {note.trim() ||
                  "Hey — you've been added to our Forge workspace. Sign in with your SSO account to get started."}
                <br />
                <br />
                <span className="text-ember underline">Accept the invite →</span>
              </div>
            </div>
          </details>
        </div>
      </CenterModal>

      <Confirm
        open={!!removeTarget}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
        variant="destructive"
        typeToConfirm={removeTarget?.email}
        title={`Remove ${removeTarget?.email}?`}
        description="They lose access to this workspace immediately. Their user record stays intact for other workspaces."
        primaryLabel="Remove member"
        loading={removeMember.isPending}
        onConfirm={async () => {
          if (!removeTarget) return;
          await removeMember.mutateAsync({ userId: removeTarget.userId });
          setRemoveTarget(null);
        }}
      />
    </>
  );
}
