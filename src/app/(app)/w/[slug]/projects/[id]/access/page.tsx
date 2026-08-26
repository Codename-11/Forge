"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LockKeyhole, ShieldCheck, UserPlus, Users } from "lucide-react";
import { ProjectAccessRole, ProjectVisibility } from "@prisma/client";
import { Topbar } from "@/components/topbar";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Combobox } from "@/components/ui/combobox";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { EmptyState, Section, Skeleton } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";

const ROLE_COPY: Record<ProjectAccessRole, { label: string; description: string }> = {
  VIEWER: {
    label: "Viewer",
    description: "View this project and its issues, comments, artifacts, and activity.",
  },
  CONTRIBUTOR: {
    label: "Contributor",
    description: "View and create or update work. Cannot manage access or project settings.",
  },
  MANAGER: {
    label: "Manager",
    description:
      "Contributor access plus project settings, access, integrations, archive, and delete.",
  },
};

const ROLE_OPTIONS = Object.values(ProjectAccessRole).map((role) => ({
  value: role,
  label: ROLE_COPY[role].label,
}));

export default function ProjectAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const router = useRouter();
  const workspace = useWorkspace();
  const utils = trpc.useUtils();
  const projectQuery = trpc.project.byId.useQuery({ id });
  const accessQuery = trpc.projectAccess.list.useQuery({ projectId: id });
  const candidateQuery = trpc.projectAccess.candidates.useQuery({ projectId: id });
  const [visibilityTarget, setVisibilityTarget] = useState<ProjectVisibility | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [membershipId, setMembershipId] = useState("");
  const [role, setRole] = useState<ProjectAccessRole>(ProjectAccessRole.VIEWER);
  const [removeTarget, setRemoveTarget] = useState<{
    membershipId: string;
    name: string;
    fallback: boolean;
  } | null>(null);

  const invalidate = async () => {
    await Promise.all([
      utils.project.byId.invalidate({ id }),
      utils.project.list.invalidate(),
      utils.projectAccess.list.invalidate({ projectId: id }),
      utils.projectAccess.candidates.invalidate({ projectId: id }),
    ]);
  };

  const updateProject = trpc.project.update.useMutation({
    onSuccess: invalidate,
  });
  const setAccess = trpc.projectAccess.set.useMutation({
    onSuccess: async () => {
      await invalidate();
      setAddOpen(false);
      setMembershipId("");
      setRole(ProjectAccessRole.VIEWER);
    },
  });
  const removeAccess = trpc.projectAccess.remove.useMutation({ onSuccess: invalidate });

  const directMembershipIds = useMemo(
    () => new Set((accessQuery.data ?? []).map((grant) => grant.membership.id)),
    [accessQuery.data],
  );
  const candidates = useMemo(
    () =>
      (candidateQuery.data ?? []).filter(
        (member) => member.mutable && !directMembershipIds.has(member.membershipId),
      ),
    [candidateQuery.data, directMembershipIds],
  );
  const peopleLosingInheritedAccess = useMemo(
    () =>
      (candidateQuery.data ?? []).filter(
        (member) =>
          member.workspaceRole === "MEMBER" && !directMembershipIds.has(member.membershipId),
      ).length,
    [candidateQuery.data, directMembershipIds],
  );

  const project = projectQuery.data;
  if (projectQuery.error || accessQuery.error) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <EmptyState
          variant="page"
          icon={<LockKeyhole />}
          title="Project unavailable"
          description="It may have been removed or your access may have changed."
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => router.push(`/w/${workspace.slug}/projects`)}
            >
              Back to projects
            </Button>
          }
        />
      </div>
    );
  }
  if (!project || accessQuery.isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-52 w-full" />
      </div>
    );
  }

  const isRestricted = project.visibility === ProjectVisibility.RESTRICTED;

  return (
    <>
      <Topbar
        title="Project access"
        subtitle={`${project.key} · ${project.name}`}
        actions={
          <Link href={`/w/${workspace.slug}/projects/${project.id}`}>
            <Button size="sm" variant="outline">
              Back to project
            </Button>
          </Link>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
          <Section
            title="Visibility"
            hint="Visibility controls inherited access. Direct project roles remain in effect."
          >
            <div
              role="radiogroup"
              aria-label="Project visibility"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              <VisibilityChoice
                checked={!isRestricted}
                title="Workspace"
                description="Workspace members can view and contribute. Guests need a direct role."
                onSelect={() => isRestricted && setVisibilityTarget(ProjectVisibility.WORKSPACE)}
              />
              <VisibilityChoice
                checked={isRestricted}
                title="Restricted"
                description="Only workspace admins and people listed below can access this project."
                onSelect={() => !isRestricted && setVisibilityTarget(ProjectVisibility.RESTRICTED)}
              />
            </div>
          </Section>

          <Section
            title="People"
            hint="Direct roles can narrow collaboration without changing anyone's workspace role."
            actions={
              <Button size="sm" variant="ember" onClick={() => setAddOpen(true)}>
                <UserPlus className="h-3.5 w-3.5" aria-hidden /> Add person
              </Button>
            }
          >
            <Card as="div">
              <div className="flex items-start gap-3 border-b border-border/60 p-4">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-success/10 text-success">
                  <ShieldCheck className="h-4 w-4" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">Workspace owners and admins</div>
                  <p className="text-meta mt-0.5 text-muted-foreground">
                    Workspace admin · always has full project access
                  </p>
                </div>
                <Badge>inherited</Badge>
              </div>

              {(accessQuery.data ?? []).map((grant) => {
                const person = grant.membership.user;
                const displayName = person.name || person.email;
                return (
                  <div
                    key={grant.id}
                    className="flex flex-col gap-3 border-b border-border/60 p-4 last:border-b-0 sm:flex-row sm:items-center"
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Avatar image={person.image} name={displayName} size={32} />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{displayName}</div>
                        <div className="text-meta truncate text-muted-foreground">
                          {person.name ? person.email : grant.membership.role.toLowerCase()}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 sm:justify-end">
                      <Combobox
                        ariaLabel={`Project role for ${displayName}`}
                        value={grant.role}
                        options={ROLE_OPTIONS}
                        onChange={(value) =>
                          value &&
                          setAccess.mutate({
                            projectId: id,
                            membershipId: grant.membership.id,
                            role: value as ProjectAccessRole,
                          })
                        }
                        className="min-w-36 flex-1 sm:flex-none"
                      />
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          setRemoveTarget({
                            membershipId: grant.membership.id,
                            name: displayName,
                            fallback: !isRestricted && grant.membership.role === "MEMBER",
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                );
              })}

              {(accessQuery.data ?? []).length === 0 && (
                <EmptyState
                  variant="section"
                  icon={<Users />}
                  title={isRestricted ? "No direct project roles" : "No additional project roles"}
                  description={
                    isRestricted
                      ? "Only workspace admins can access this project. Add a person before sharing it."
                      : "Workspace members inherit contributor access. Guests still need a direct role."
                  }
                  action={
                    <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
                      Add person
                    </Button>
                  }
                />
              )}
            </Card>
          </Section>
        </div>
      </div>

      <QuickForm
        open={addOpen}
        onOpenChange={setAddOpen}
        title="Add project access"
        description="Choose a workspace member and the smallest role they need."
        primaryLabel="Grant access"
        loading={setAccess.isPending}
        onSubmit={async () => {
          if (!membershipId) return { error: "Choose a workspace member." };
          try {
            await setAccess.mutateAsync({ projectId: id, membershipId, role });
          } catch (error) {
            return { error: error instanceof Error ? error.message : "Could not grant access." };
          }
        }}
      >
        <QuickForm.Field label="Person" required>
          <Combobox
            ariaLabel="Person"
            value={membershipId || null}
            placeholder="Choose a member…"
            onChange={(value) => setMembershipId(value ?? "")}
            options={candidates.map((member) => ({
              value: member.membershipId,
              label: `${member.user.name || member.user.email} · ${member.workspaceRole.toLowerCase()}`,
            }))}
          />
        </QuickForm.Field>
        <QuickForm.Field label="Project role" hint={ROLE_COPY[role].description}>
          <Combobox
            ariaLabel="Project role"
            value={role}
            options={ROLE_OPTIONS}
            onChange={(value) => value && setRole(value as ProjectAccessRole)}
          />
        </QuickForm.Field>
      </QuickForm>

      <Confirm
        open={visibilityTarget !== null}
        onOpenChange={(open) => !open && setVisibilityTarget(null)}
        title={
          visibilityTarget === ProjectVisibility.RESTRICTED
            ? `Restrict ${project.name}?`
            : `Make ${project.name} workspace-visible?`
        }
        description={
          visibilityTarget === ProjectVisibility.RESTRICTED ? (
            <>
              Members without a direct role will lose access. Based on the current roster, this
              affects {peopleLosingInheritedAccess}{" "}
              {peopleLosingInheritedAccess === 1 ? "person" : "people"}. Existing direct roles
              remain.
            </>
          ) : (
            "All workspace members gain view and contributor access. Guests still need a direct role, and existing managers remain managers."
          )
        }
        primaryLabel={
          visibilityTarget === ProjectVisibility.RESTRICTED
            ? "Restrict project"
            : "Make workspace-visible"
        }
        loading={updateProject.isPending}
        onConfirm={async () => {
          if (!visibilityTarget) return;
          await updateProject.mutateAsync({ id, visibility: visibilityTarget });
          setVisibilityTarget(null);
        }}
      />

      <Confirm
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Remove ${removeTarget?.name ?? "this person"}?`}
        description={
          removeTarget?.fallback
            ? "Their direct role is removed. They fall back to workspace member access."
            : "Their direct role is removed and they will lose access to this restricted project."
        }
        primaryLabel="Remove access"
        loading={removeAccess.isPending}
        onConfirm={async () => {
          if (!removeTarget) return;
          await removeAccess.mutateAsync({
            projectId: id,
            membershipId: removeTarget.membershipId,
          });
          setRemoveTarget(null);
        }}
      />
    </>
  );
}

function VisibilityChoice({
  checked,
  title,
  description,
  onSelect,
}: {
  checked: boolean;
  title: string;
  description: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={`focus-ring rounded-lg border p-4 text-left transition-colors ${
        checked ? "border-ember bg-ember/5" : "border-border bg-card/40 hover:bg-card"
      }`}
    >
      <span className="flex items-center gap-2 text-sm font-medium">
        {title === "Restricted" ? (
          <LockKeyhole className="h-3.5 w-3.5" aria-hidden />
        ) : (
          <Users className="h-3.5 w-3.5" aria-hidden />
        )}
        {title}
        {checked && <Badge className="ml-auto">current</Badge>}
      </span>
      <span className="text-meta mt-1 block leading-relaxed text-muted-foreground">
        {description}
      </span>
    </button>
  );
}
