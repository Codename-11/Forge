"use client";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { Download, Upload } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/settings/card";
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
        <div className="mx-auto max-w-3xl space-y-6 p-6">
          <Card>
            <div className="space-y-4 p-5">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Download className="h-4 w-4 text-muted-foreground" />
                  Export workspace
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Download statuses, labels, initiatives, projects, sprints,
                  agents, issues (with assignees, labels &amp; relations), and
                  comments as a single JSON file. Infra rows (API keys,
                  webhooks, audit log, attachment bytes) are not included.
                </p>
              </div>
              <Button
                variant="ember"
                size="sm"
                onClick={handleExport}
                disabled={exporting}
              >
                {exporting ? "Exporting…" : "Export to JSON"}
              </Button>
            </div>
          </Card>

          <Card>
            <div className="space-y-4 p-5">
              <div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  <Upload className="h-4 w-4 text-muted-foreground" />
                  Import into{" "}
                  <span className="font-mono">{workspace.data?.name ?? "this workspace"}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Loads a Forge export into the current workspace.{" "}
                  <strong>Additive</strong> — config rows are matched by name /
                  key and reused; issues are always created fresh with new
                  numbers. Nothing is deleted. Unknown authors fall back to you.
                </p>
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={handleFilePicked}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
              >
                Choose JSON file…
              </Button>
            </div>
          </Card>

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
