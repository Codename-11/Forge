"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Ban, ChevronRight, RefreshCw, Send, Users, X } from "lucide-react";
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
 * Workspace members and invitation settings — admin-gated.
 *
 * Admins issue expiring email invitations; recipients receive membership only
 * after authenticating as the invited email. Existing members remain managed
 * through the role and removal controls below. Every mutation is server-gated
 * by `adminProcedure`, even if a non-admin guesses this route.
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

type ChipStatus = "ready" | "exists" | "pending" | "invalid";
type Chip = { email: string; status: ChipStatus };

/**
 * Parse a raw recipients blob into de-duped, validated chips. Splits on
 * commas, whitespace, and newlines; lowercases for both de-dup and existing
 * member / pending-invite checks.
 */
function parseRecipients(raw: string, memberEmails: Set<string>, pendingEmails: Set<string>): Chip[] {
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
        : pendingEmails.has(email)
          ? "pending"
          : "ready";
    chips.push({ email, status });
  }
  return chips;
}

export default function MembersPage() {
  const utils = trpc.useUtils();
  const { data: members, refetch, isLoading } =
    trpc.workspace.listMembers.useQuery();
  const { data: invitations } = trpc.workspace.listInvitations.useQuery();
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
  const pendingEmails = useMemo(
    () =>
      new Set(
        (invitations ?? [])
          .filter((invite) => invite.status === "PENDING")
          .map((invite) => invite.email.toLowerCase()),
      ),
    [invitations],
  );
  const chips = useMemo(
    () => parseRecipients(recipientsRaw, memberEmails, pendingEmails),
    [recipientsRaw, memberEmails, pendingEmails],
  );
  const readyChips = chips.filter((c) => c.status === "ready");
  const existsCount = chips.filter((c) => c.status === "exists").length;
  const pendingCount = chips.filter((c) => c.status === "pending").length;
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

  const inviteMember = trpc.workspace.invite.useMutation();
  const resendInvitation = trpc.workspace.resendInvitation.useMutation({
    onSuccess: async () => {
      toast.success("Invitation resent with a new secure link.");
      await utils.workspace.listInvitations.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const revokeInvitation = trpc.workspace.revokeInvitation.useMutation({
    onSuccess: async () => {
      toast.success("Invitation revoked.");
      await utils.workspace.listInvitations.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  /** Send one secure invitation per ready recipient and summarize outcomes. */
  async function sendInvites() {
    if (readyCount === 0 || sending) return;
    if (readyCount > 20) {
      toast.error("Send at most 20 invitations at a time.");
      return;
    }
    setSending(true);
    try {
      const results = await Promise.allSettled(
        readyChips.map((c) =>
          inviteMember.mutateAsync({ email: c.email, role: inviteRole, note: note.trim() || undefined }),
        ),
      );
      let sent = 0;
      let duplicates = 0;
      let failed = 0;
      for (const result of results) {
        if (result.status === "rejected") failed += 1;
        else if (result.value.outcome === "sent") sent += 1;
        else duplicates += 1;
      }
      const parts: string[] = [];
      if (sent) parts.push(`Sent ${sent}`);
      if (duplicates) parts.push(`${duplicates} already pending`);
      if (failed) parts.push(`${failed} failed`);
      const summary = parts.join(" · ") || "Nothing to send.";
      if (failed && !sent) toast.error(summary);
      else toast.success(summary);

      await utils.workspace.listInvitations.invalidate();
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
        subtitle="Invite teammates securely, then manage workspace roles and access."
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
            hint="People who accepted an invitation or already had access. Change roles or remove access here."
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
                hint="Members are people with active workspace access. Invite a teammate by email and they’ll appear here after accepting with the invited account."
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
            title="Invitations"
            hint="Secure links expire automatically. Resending rotates the link; revoking disables it immediately."
            actions={
              invitations && invitations.length > 0 ? (
                <span className="text-meta tabular-nums text-muted-foreground">
                  {invitations.filter((invite) => invite.status === "PENDING").length} pending
                </span>
              ) : undefined
            }
          >
            {!invitations?.length ? (
              <EmptyState
                as="div"
                icon={Send}
                title="No invitations yet"
                hint="Pending and completed invitation history will appear here."
              />
            ) : (
              <Card>
                {invitations.map((invite) => (
                  <li key={invite.id} className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-mono text-sm text-foreground">{invite.email}</span>
                        <Badge
                          className={cn(
                            invite.status === "PENDING" && "bg-warning/10 text-warning",
                            invite.status === "ACCEPTED" && "bg-success/10 text-success",
                            invite.status === "REVOKED" && "bg-danger/10 text-danger",
                          )}
                        >
                          {invite.status.toLowerCase()}
                        </Badge>
                        <Badge>{invite.role.toLowerCase()}</Badge>
                      </div>
                      <p className="mt-1 text-meta text-muted-foreground">
                        {invite.status === "PENDING"
                          ? `Expires ${relativeTime(invite.expiresAt)}`
                          : invite.status === "ACCEPTED" && invite.acceptedAt
                            ? `Accepted ${relativeTime(invite.acceptedAt)}`
                            : invite.status === "REVOKED" && invite.revokedAt
                              ? `Revoked ${relativeTime(invite.revokedAt)}`
                              : `Expired ${relativeTime(invite.expiresAt)}`}
                        {invite.sendCount > 0 ? ` · sent ${invite.sendCount}×` : ""}
                      </p>
                      {invite.lastSendError && (
                        <p className="mt-1 text-meta text-danger">Delivery failed: {invite.lastSendError}</p>
                      )}
                    </div>
                    {invite.status === "PENDING" && (
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={resendInvitation.isPending || revokeInvitation.isPending}
                          onClick={() => resendInvitation.mutate({ invitationId: invite.id })}
                        >
                          <RefreshCw className="h-3.5 w-3.5" />
                          Resend
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={resendInvitation.isPending || revokeInvitation.isPending}
                          onClick={() => revokeInvitation.mutate({ invitationId: invite.id })}
                        >
                          <Ban className="h-3.5 w-3.5" />
                          Revoke
                        </Button>
                      </div>
                    )}
                  </li>
                ))}
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
        description="Recipients receive a secure, expiring link and join only after signing in as the invited email."
        footer={
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <span className="text-[0.6875rem] text-muted-foreground">
              {readyCount === 0
                ? "Add at least one valid email"
                : readyCount > 20
                  ? "Send at most 20 invitations at a time"
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
                disabled={sending || readyCount === 0 || readyCount > 20}
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
                      c.status === "pending" &&
                        "border-ember/40 bg-ember/10 text-ember",
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
                    {c.status === "pending" && (
                      <span className="text-[10px]">invite pending</span>
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
                  {pendingCount > 0 && (
                    <>
                      <span>·</span>
                      <span className="text-ember">{pendingCount} already pending</span>
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
            hint="Included as plain text in the invitation email."
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
                &lt;configured sender&gt;
              </div>
              <div className="mt-0.5">
                <span className="text-foreground">Subject</span> ·{" "}
                {me?.user.name ?? me?.user.email ?? "An admin"} invited you to
                {workspace?.name ? ` "${workspace.name}"` : " your workspace"} on Forge
              </div>
              <div className="mt-2 rounded-md border border-border bg-card/30 p-3 text-sm leading-relaxed text-foreground/90">
                {note.trim() ||
                  "Hey — you’ve been invited to our Forge workspace. Use the secure link, then sign in or create an account to join."}
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
