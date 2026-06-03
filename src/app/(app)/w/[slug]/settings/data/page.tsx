"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/settings/card";
import { Section } from "@/components/settings/section";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";

type PendingImport = { snapshot: unknown; filename: string; summary: string } | null;

export default function DataPortabilityPage() {
  const utils = trpc.useUtils();
  const workspace = trpc.workspace.current.useQuery();
  const [exporting, setExporting] = useState(false);
  const [pending, setPending] = useState<PendingImport>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const importM = trpc.dataPortability.import.useMutation({
    onSuccess: (s) => {
      toast.success(
        `Imported ${s.issues} issues, ${s.projects} projects, ${s.comments} comments.`,
      );
      setPending(null);
      // Refresh the obvious surfaces the import touched.
      utils.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  async function handleExport() {
    setExporting(true);
    try {
      const snap = await utils.dataPortability.export.fetch();
      const blob = new Blob([JSON.stringify(snap, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `forge-${snap.workspace.key.toLowerCase()}-${stamp}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`Exported ${snap.issues.length} issues.`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  function handleFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        if (typeof parsed !== "object" || parsed === null || !("issues" in parsed)) {
          throw new Error("This doesn't look like a Forge export.");
        }
        const counts = parsed as {
          issues?: unknown[];
          projects?: unknown[];
          comments?: unknown[];
          workspace?: { name?: string };
        };
        const summary = `${counts.issues?.length ?? 0} issues · ${
          counts.projects?.length ?? 0
        } projects · ${counts.comments?.length ?? 0} comments${
          counts.workspace?.name ? ` (from "${counts.workspace.name}")` : ""
        }`;
        setPending({ snapshot: parsed, filename: file.name, summary });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Could not read file.");
      }
    };
    reader.readAsText(file);
  }

  return (
    <>
      <Topbar
        title="Data export / import"
        subtitle="Portable JSON snapshots of this workspace's core content."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 p-4 sm:p-6">
          <Section
            title="Export workspace"
            hint="Download a portable JSON snapshot. Use it for backup, migrations, or seeding a demo workspace."
          >
            <Card as="div" className="divide-y-0 space-y-4 p-5">
              <p className="text-xs text-muted-foreground">
                Download statuses, labels, initiatives, projects, sprints,
                agents, issues (with assignees, labels &amp; relations), and
                comments as a single JSON file. Infra rows (API keys,
                webhooks, audit log, attachment bytes) are not included.
              </p>
              <Button
                variant="ember"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
              >
                <Download className="h-3.5 w-3.5" />
                {exporting ? "Exporting…" : "Export to JSON"}
              </Button>
            </Card>
          </Section>

          <Section
            title="Import into Forge"
            hint="Load a Forge export into this workspace. Import is additive — nothing is ever deleted."
          >
            <Card as="div" className="divide-y-0 space-y-4 p-5">
              <p className="text-xs text-muted-foreground">
                Loads a Forge export into{" "}
                <span className="font-mono">
                  {workspace.data?.name ?? "this workspace"}
                </span>
                . <strong>Additive</strong> — config rows are matched by name /
                key and reused; issues are always created fresh with new
                numbers. Nothing is deleted. Unknown authors fall back to you.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleFilePicked}
              />
              <div className="flex flex-col items-center gap-3 rounded-md border border-dashed border-border bg-background/40 px-4 py-8 text-center">
                <Upload className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
                <div className="text-sm font-medium">Choose a forge-*.json file</div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => fileRef.current?.click()}
                >
                  Choose JSON file…
                </Button>
                <div className="text-[0.6875rem] text-muted-foreground/70">
                  You&apos;ll get a confirmation summary before anything is written.
                </div>
              </div>
            </Card>
          </Section>

          <Section
            title="What's portable"
            hint="The export is a faithful copy of the configuration you've built in Forge. Infra-level data — anything tied to a deployment — does not travel."
          >
            <Card as="div" className="divide-y-0">
              <div className="grid grid-cols-1 divide-y divide-border/60 sm:grid-cols-2 sm:divide-x sm:divide-y-0">
                <div className="p-4">
                  <div className="text-[0.6875rem] text-success">✓ Included</div>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {[
                      "Workspace settings",
                      "Statuses, labels, initiatives",
                      "Projects + members linkage",
                      "Sprints, goals, plans",
                      "Agents & dispatch rules",
                      "Issues, comments, relations, labels",
                    ].map((s) => (
                      <li key={s}>· {s}</li>
                    ))}
                  </ul>
                </div>
                <div className="p-4">
                  <div className="text-[0.6875rem] text-danger">✗ Not included</div>
                  <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                    {[
                      "API keys & MCP secrets",
                      "Webhook delivery queue",
                      "Audit log",
                      "Attachment bytes (manifests only)",
                      "SSO provider credentials",
                    ].map((s) => (
                      <li key={s}>· {s}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Card>
          </Section>

          <p className="text-xs text-muted-foreground">
            For a full-fidelity replica of a deployed workspace locally, use{" "}
            <span className="font-mono">pnpm db:clone-prod</span> instead — it
            copies every row at the Postgres level.
          </p>
        </div>
      </div>

      <Confirm
        open={!!pending}
        onOpenChange={(v) => !v && setPending(null)}
        title="Import this snapshot?"
        description={
          pending
            ? `${pending.filename} — ${pending.summary}. This adds rows to the current workspace and cannot be undone automatically.`
            : ""
        }
        primaryLabel="Import"
        loading={importM.isPending}
        onConfirm={async () => {
          if (!pending) return;
          // The server re-validates with the full zod schema; we only did a
          // shallow shape check on the client.
          await importM.mutateAsync({ snapshot: pending.snapshot as never });
        }}
      />
    </>
  );
}
