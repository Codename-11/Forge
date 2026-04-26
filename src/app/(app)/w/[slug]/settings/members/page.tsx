"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
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

export default function MembersPage() {
  const { data: members, refetch, isLoading } =
    trpc.workspace.listMembers.useQuery();
  const { data: me } = trpc.workspace.me.useQuery();
  const [addOpen, setAddOpen] = useState(false);
  const [addRole, setAddRole] = useState<Role>("MEMBER");
  const [removeTarget, setRemoveTarget] = useState<{
    userId: string;
    email: string;
  } | null>(null);

  const addMember = trpc.workspace.addMember.useMutation({
    onSuccess: (res) => {
      toast.success(res.created ? "Member added." : "Already a member — no change.");
      setAddOpen(false);
      setAddRole("MEMBER");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

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
        subtitle="Admin-gated access for this workspace."
        actions={
          <Button variant="ember" size="sm" onClick={() => setAddOpen(true)}>
            Add member
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card>
            {(members ?? []).map((m) => {
              const isSelf = me?.user.id === m.userId;
              return (
                <li
                  key={m.membershipId}
                  className="flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-subtle/40"
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
                    </div>
                  </div>
                  <select
                    value={m.role}
                    disabled={setMemberRole.isPending}
                    onChange={(e) =>
                      setMemberRole.mutate({
                        userId: m.userId,
                        role: e.target.value as Role,
                      })
                    }
                    className="focus-ring h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground disabled:opacity-50"
                    aria-label={`Role for ${m.email}`}
                  >
                    {ROLES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    joined {relativeTime(m.joinedAt)}
                  </span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={removeMember.isPending}
                    onClick={() =>
                      setRemoveTarget({ userId: m.userId, email: m.email })
                    }
                  >
                    Remove
                  </Button>
                </li>
              );
            })}
            {!isLoading && members?.length === 0 && (
              <EmptyState
                icon={Users}
                title="No members yet"
                hint="Add teammates by email — they bind on first SSO login."
              />
            )}
          </Card>
        </div>
      </div>

      <QuickForm
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add member"
        description="They'll get access once Authelia lets this email through. Role can be changed later."
        primaryLabel={addMember.isPending ? "Adding…" : "Add"}
        loading={addMember.isPending}
        onSubmit={(e) => {
          const fd = new FormData(e.currentTarget);
          const email = String(fd.get("email") ?? "").trim();
          const role = String(fd.get("role") ?? "MEMBER") as Role;
          if (!email.includes("@")) {
            return { error: "Enter a valid email." };
          }
          addMember.mutate({ email, role });
        }}
      >
        <QuickForm.Field label="Email" htmlFor="add-member-email" required>
          <Input
            id="add-member-email"
            name="email"
            type="email"
            placeholder="teammate@example.com"
            autoFocus
            required
          />
        </QuickForm.Field>
        <QuickForm.Field label="Role" htmlFor="add-member-role">
          <select
            id="add-member-role"
            name="role"
            value={addRole}
            onChange={(e) => setAddRole(e.target.value as Role)}
            className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm text-foreground"
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </QuickForm.Field>
      </QuickForm>

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
