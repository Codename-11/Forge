"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Users } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { trpc } from "@/lib/trpc";
import { initials, relativeTime } from "@/lib/utils";

const ROLES = ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const;
type Role = (typeof ROLES)[number];

export default function MembersPage() {
  const { data: members, refetch } = trpc.workspace.members.useQuery();
  const { data: me } = trpc.workspace.me.useQuery();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("MEMBER");
  const [removeTarget, setRemoveTarget] = useState<{
    membershipId: string;
    email: string;
  } | null>(null);

  const invite = trpc.workspace.invite.useMutation({
    onSuccess: () => {
      toast.success("Member added.");
      setOpen(false);
      setEmail("");
      setRole("MEMBER");
      refetch();
    },
    onError: (e) => toast.error(e.message),
  });

  const updateMember = trpc.workspace.updateMember.useMutation({
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
        subtitle="Teammates with access to this workspace."
        actions={
          <Button variant="ember" size="sm" onClick={() => setOpen(true)}>
            Invite
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card>
            {(members ?? []).map((m) => {
              const isSelf = me?.id === m.id;
              return (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-subtle text-xs font-medium">
                    {initials(m.user.name ?? m.user.email)}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <div className="truncate text-sm font-medium">
                        {m.user.name ?? m.user.email}
                      </div>
                      {isSelf && <Badge>you</Badge>}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {m.user.email}
                      {m.user.handle && (
                        <>
                          {" "}
                          · <span className="font-mono">@{m.user.handle}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <select
                    value={m.role}
                    disabled={isSelf || updateMember.isPending}
                    onChange={(e) =>
                      updateMember.mutate({
                        membershipId: m.id,
                        role: e.target.value as Role,
                      })
                    }
                    className="focus-ring h-7 rounded-md border border-input bg-background px-2 text-xs disabled:opacity-50"
                  >
                    {ROLES.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                  <span className="text-[11px] text-muted-foreground">
                    {relativeTime(m.createdAt)}
                  </span>
                  {!isSelf && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={removeMember.isPending}
                      onClick={() =>
                        setRemoveTarget({ membershipId: m.id, email: m.user.email })
                      }
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
            {members?.length === 0 && (
              <EmptyState
                icon={Users}
                title="No members yet"
                hint="Invite teammates to collaborate on this workspace."
              />
            )}
          </Card>
        </div>
      </div>

      <Dialog open={open} onClose={() => setOpen(false)} className="max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!email.includes("@")) return toast.error("Enter a valid email.");
            invite.mutate({ email: email.trim(), role });
          }}
          className="space-y-3 p-5"
        >
          <div className="text-sm font-semibold">Invite member</div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Email</label>
            <Input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="teammate@example.com"
              type="email"
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Role</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as Role)}
              className="focus-ring h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="ember" disabled={invite.isPending}>
              {invite.isPending ? "Adding…" : "Add"}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Invites currently attach the user directly. Email-based invitations ship later.
          </p>
        </form>
      </Dialog>

      <Confirm
        open={!!removeTarget}
        onOpenChange={(v) => !v && setRemoveTarget(null)}
        variant="destructive"
        title={`Remove ${removeTarget?.email}?`}
        description="They lose access to this workspace immediately."
        primaryLabel="Remove"
        loading={removeMember.isPending}
        onConfirm={async () => {
          if (!removeTarget) return;
          await removeMember.mutateAsync({ membershipId: removeTarget.membershipId });
          setRemoveTarget(null);
        }}
      />
    </>
  );
}
