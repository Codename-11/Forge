"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, ArrowRight, UserRound, UsersRound } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Card, EmptyState, MOTION, Section, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Workspace directory. Lives at `/workspaces` (not
 * under any `/w/[slug]`) so it remains reachable when the user has no
 * active workspace. Workspace-scoped settings (rename, sprint length, danger
 * zone) live under `/w/[slug]/settings/workspace`; this page is about
 * moving *between* workspaces plus creating new ones.
 *
 * `workspace.create` seeds profile-aware labels and defaults. Personal
 * workspaces intentionally skip the initial sprint.
 */
export default function WorkspacesContent() {
  const router = useRouter();
  const { data: workspaces, refetch, isLoading, isError } = trpc.workspace.list.useQuery();
  // Cross-workspace mini-stats (members / openIssues / agents / activeRuns),
  // keyed by id so each row can show its tiles. Loads alongside the list;
  // tiles render once it resolves (rows still work without it).
  const { data: stats } = trpc.global.workspaces.useQuery();
  const statsById = useMemo(
    () => new Map((stats ?? []).map((s) => [s.id, s])),
    [stats],
  );
  const setLast = trpc.workspace.setLastWorkspace.useMutation();
  const [createOpen, setCreateOpen] = useState(false);

  function open(w: { id: string; slug: string }) {
    setLast.mutate({ workspaceId: w.id });
    router.push(`/w/${w.slug}/inbox`);
  }

  return (
    <>
      <Topbar
        title="Workspaces"
        subtitle="Open a workspace you belong to, or create a new one."
        actions={
          <Button size="sm" variant="ember" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Create workspace
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-4 p-6">
          <Section
            title="Your workspaces"
            hint="Click a workspace to resume. Role is set by the owner."
          >
            {isLoading ? (
              <SkeletonList rows={3} />
            ) : isError ? (
              <EmptyState title="Workspaces are unavailable" description="Try loading your workspace directory again." action={<Button size="sm" variant="outline" onClick={() => void refetch()}>Try again</Button>} />
            ) : (
            <Card as="ul">
              {(workspaces?.length ?? 0) === 0 && (
                <EmptyState
                  as="li"
                  variant="section"
                  icon={<Plus />}
                  title="No workspaces yet"
                  description="Create one to get started."
                  action={
                    <Button size="sm" variant="ember" onClick={() => setCreateOpen(true)}>
                      Create workspace
                    </Button>
                  }
                />
              )}
              {workspaces?.map((w) => {
                const c = workspaceColor(w.key);
                const role = w.memberships[0]?.role ?? "MEMBER";
                const st = statsById.get(w.id);
                return (
                  <li key={w.id} className="flex items-center gap-2 pr-4">
                    <button
                      type="button"
                      onClick={() => open(w)}
                      className="focus-ring group flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left hover:bg-subtle/60"
                    >
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md font-mono text-[0.6875rem] font-semibold"
                        style={{
                          backgroundColor: c.bg,
                          color: c.fg,
                          boxShadow: `inset 0 0 0 1px ${c.ring}`,
                        }}
                      >
                        {w.key.slice(0, 3)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="truncate text-sm font-medium">{w.name}</span>
                          <span className="font-mono text-[0.6875rem] text-muted-foreground">
                            {w.key}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">
                          /{w.slug} · role {role.toLowerCase()}
                        </div>
                      </div>
                      {st && (
                        <div className="hidden shrink-0 items-center gap-4 sm:flex">
                          <Stat label="members" value={st.members} />
                          <Stat label="open" value={st.openIssues} />
                          <Stat label="agents" value={st.agents} />
                          <Stat label="live" value={st.activeRuns} ember={st.activeRuns > 0} />
                        </div>
                      )}
                      <ArrowRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-ember", MOTION.fast)} />
                    </button>
                    {(role === "OWNER" || role === "ADMIN") && (
                        <Link
                          href={`/w/${w.slug}/settings/workspace`}
                          aria-label={`Manage ${w.name}`}
                          className="focus-ring shrink-0 rounded px-2 py-2 text-xs text-muted-foreground hover:bg-subtle hover:text-ember"
                        >
                          Manage
                        </Link>
                    )}
                  </li>
                );
              })}
            </Card>
            )}
          </Section>

        </div>
      </div>

      <CreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(slug) => {
          refetch();
          router.push(`/w/${slug}/inbox`);
        }}
        existingKeys={new Set(workspaces?.map((w) => w.key) ?? [])}
        existingSlugs={new Set(workspaces?.map((w) => w.slug) ?? [])}
      />
    </>
  );
}

function CreateDialog({
  open,
  onClose,
  onCreated,
  existingKeys,
  existingSlugs,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (slug: string) => void;
  existingKeys: Set<string>;
  existingSlugs: Set<string>;
}) {
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [slug, setSlug] = useState("");
  const [cycleLengthDays, setCycleLengthDays] = useState(7);
  const [timeTrackingEnabled, setTimeTrackingEnabled] = useState(false);
  const [experienceProfile, setExperienceProfile] = useState<"TEAM" | "PERSONAL">("TEAM");

  const create = trpc.workspace.create.useMutation({
    onSuccess: (ws) => {
      toast.success("Workspace created.");
      reset();
      onClose();
      onCreated(ws.slug);
    },
    onError: (e) => toast.error(e.message),
  });

  function reset() {
    setName("");
    setKey("");
    setSlug("");
    setCycleLengthDays(7);
    setTimeTrackingEnabled(false);
    setExperienceProfile("TEAM");
  }

  function onNameChange(v: string) {
    setName(v);
    if (!slug) {
      setSlug(
        v
          .toLowerCase()
          .trim()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 48),
      );
    }
    if (!key) {
      const suggested = v
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 3)
        .map((w) => w[0]?.toUpperCase() ?? "")
        .join("");
      const singleWord = v.replace(/[^a-zA-Z]/g, "").slice(0, 3).toUpperCase();
      if (suggested.length >= 2) setKey(suggested.slice(0, 5));
      else if (singleWord.length >= 2) setKey(singleWord);
    }
  }

  const issues = useMemo(() => {
    const errs: string[] = [];
    if (name.trim().length < 1) errs.push("Name is required.");
    if (!/^[A-Z]{2,6}$/.test(key)) errs.push("Key must be 2–6 uppercase letters.");
    else if (existingKeys.has(key)) errs.push(`Key ${key} is already in use.`);
    if (!/^[a-z0-9-]{2,48}$/.test(slug))
      errs.push("Slug must be 2–48 lowercase alphanumeric chars or dashes.");
    else if (existingSlugs.has(slug)) errs.push(`Slug ${slug} is already in use.`);
    if (experienceProfile === "TEAM" && (cycleLengthDays < 1 || cycleLengthDays > 90))
      errs.push("Sprint length must be between 1 and 90 days.");
    return errs;
  }, [name, key, slug, cycleLengthDays, experienceProfile, existingKeys, existingSlugs]);

  return (
    <Dialog open={open} onClose={onClose} className="max-w-lg">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (issues.length > 0) return;
          create.mutate({
            name: name.trim(),
            key,
            slug,
            cycleLengthDays,
            timeTrackingEnabled,
            experienceProfile,
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">Create workspace</div>
        <p className="text-[0.6875rem] text-muted-foreground">
          The key shows up in issue identifiers like <span className="font-mono">ACME-42</span>
          {" "}and is permanent. Slug appears in URLs; it can be renamed later by an
          owner via a data migration.
        </p>

        <Field label="How will you use it?">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setExperienceProfile("PERSONAL")}
              className={cn(
                "focus-ring rounded-lg border p-3 text-left transition-colors",
                experienceProfile === "PERSONAL"
                  ? "border-ember bg-ember/10"
                  : "border-border bg-card/40 hover:bg-subtle/60",
              )}
            >
              <UserRound className="mb-2 h-4 w-4 text-ember" />
              <div className="text-sm font-medium">For myself</div>
              <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">Today, tasks, notes, and agents.</div>
            </button>
            <button
              type="button"
              onClick={() => setExperienceProfile("TEAM")}
              className={cn(
                "focus-ring rounded-lg border p-3 text-left transition-colors",
                experienceProfile === "TEAM"
                  ? "border-ember bg-ember/10"
                  : "border-border bg-card/40 hover:bg-subtle/60",
              )}
            >
              <UsersRound className="mb-2 h-4 w-4 text-ember" />
              <div className="text-sm font-medium">With a team</div>
              <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">Projects, sprints, planning, and delivery.</div>
            </button>
          </div>
        </Field>

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            maxLength={80}
            autoFocus
            aria-label="Workspace name"
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Key (2–6 uppercase)">
            <Input
              value={key}
              onChange={(e) => setKey(e.target.value.replace(/[^a-zA-Z]/g, "").toUpperCase())}
              maxLength={6}
              placeholder="ACME"
              className="font-mono"
              aria-label="Workspace key"
            />
          </Field>
          <Field label="Slug">
            <Input
              value={slug}
              onChange={(e) =>
                setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))
              }
              maxLength={48}
              placeholder="acme"
              className="font-mono"
              aria-label="Workspace slug"
            />
          </Field>
        </div>
        {experienceProfile === "TEAM" && <div className="grid grid-cols-2 gap-3">
          <Field label="Sprint length (days)">
            <Input
              type="number"
              min={1}
              max={90}
              value={cycleLengthDays}
              onChange={(e) => setCycleLengthDays(Number(e.target.value) || 7)}
            />
          </Field>
          <Field label="Time tracking">
            <label className="flex h-8 items-center gap-2 rounded-md border border-input bg-background px-2 text-sm">
              <input
                type="checkbox"
                checked={timeTrackingEnabled}
                onChange={(e) => setTimeTrackingEnabled(e.target.checked)}
              />
              <span className="text-xs text-muted-foreground">Enable timers</span>
            </label>
          </Field>
        </div>}

        <div className="rounded-md border border-warning/40 bg-warning/5 p-2.5 text-[0.6875rem] text-warning">
          The key cannot be changed later. Pick something short and stable.
        </div>

        {issues.length > 0 && (
          <ul className="space-y-0.5 text-[0.6875rem] text-danger">
            {issues.map((m) => (
              <li key={m}>· {m}</li>
            ))}
          </ul>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="ember"
            disabled={issues.length > 0 || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create workspace"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Compact per-workspace mini-stat tile (members / open / agents / live). */
function Stat({ label, value, ember }: { label: string; value: number; ember?: boolean }) {
  return (
    <div className="text-center">
      <div
        className={cn(
          "text-sm font-semibold tabular-nums leading-none",
          ember && "text-ember",
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 text-[0.625rem] uppercase tracking-wider text-muted-foreground/70">
        {label}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
