"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, ArrowRight } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Card, EmptyState, MOTION, Section, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { cn } from "@/lib/utils";
import { workspaceColor } from "@/lib/workspace-color";

/**
 * Account-level workspaces page. Lives at `/settings/workspaces` (not
 * under any `/w/[slug]`) so it remains reachable when the user has no
 * active workspace. Workspace-scoped settings (rename, cycle length, danger
 * zone) live under `/w/[slug]/settings/workspace`; this page is about
 * moving *between* workspaces plus creating new ones.
 *
 * NOTE: `workspace.create` today seeds only defaults + statuses. Agent C
 * will extend it with MinIO bucket seeding and broader onboarding.
 */
export default function WorkspacesPage() {
  const router = useRouter();
  const { data: workspaces, refetch, isLoading } = trpc.workspace.list.useQuery();
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
        subtitle="Switch between tenants or spin up a new one."
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
                return (
                  <li key={w.id}>
                    <button
                      type="button"
                      onClick={() => open(w)}
                      className="group flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-subtle/60"
                    >
                      <span
                        className="grid h-8 w-8 shrink-0 place-items-center rounded-md font-mono text-[11px] font-semibold"
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
                          <span className="font-mono text-[10px] text-muted-foreground">
                            {w.key}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-muted-foreground">
                          /{w.slug} · role {role.toLowerCase()}
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <Link
                          href={`/w/${w.slug}/settings/workspace`}
                          onClick={(e) => e.stopPropagation()}
                          className="text-[11px] text-muted-foreground hover:text-ember"
                        >
                          Manage
                        </Link>
                        <ArrowRight className={cn("h-3.5 w-3.5 text-muted-foreground group-hover:text-ember", MOTION.fast)} />
                      </div>
                    </button>
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
      if (suggested.length >= 2) setKey(suggested.slice(0, 5));
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
    if (cycleLengthDays < 1 || cycleLengthDays > 90)
      errs.push("Cycle length must be between 1 and 90 days.");
    return errs;
  }, [name, key, slug, cycleLengthDays, existingKeys, existingSlugs]);

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
          });
        }}
        className="space-y-3 p-5"
      >
        <div className="text-sm font-semibold">Create workspace</div>
        <p className="text-[11px] text-muted-foreground">
          The key shows up in issue identifiers like <span className="font-mono">ACME-42</span>
          {" "}and is permanent. Slug appears in URLs; it can be renamed later by an
          owner via a data migration.
        </p>

        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => onNameChange(e.target.value)}
            maxLength={80}
            autoFocus
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
            />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Cycle length (days)">
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
        </div>

        <div className="rounded-md border border-warning/40 bg-warning/5 p-2.5 text-[11px] text-warning">
          The key cannot be changed later. Pick something short and stable.
        </div>

        {issues.length > 0 && (
          <ul className="space-y-0.5 text-[11px] text-danger">
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}
