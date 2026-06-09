"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Puzzle } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { PLUGIN_SCOPE_HELP, PLUGIN_SCOPE_ORDER } from "@/lib/plugin-scopes";

const statusTone: Record<string, string> = {
  APPROVED: "#65a30d",
  PENDING: "#ca8a04",
  SUSPENDED: "#d97706",
  REVOKED: "#be185d",
};

export default function PluginsPage() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: plugins, refetch } = trpc.plugin.list.useQuery();
  const approve = trpc.plugin.approve.useMutation({ onSuccess: () => refetch() });
  const suspend = trpc.plugin.suspend.useMutation({ onSuccess: () => refetch() });

  const [registerOpen, setRegisterOpen] = useState(false);
  const [rawManifest, setRawManifest] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");

  const resetInstallDialog = () => {
    setRegisterOpen(false);
    setRawManifest("");
    setWebhookUrl("");
  };

  const handleInstallResult = (result: {
    installAction: "registered" | "restored" | "updated" | "unchanged";
    addedScopes: string[];
    priorVersion: string | null;
    version: string;
  }) => {
    if (result.installAction === "updated") {
      const scopeNote =
        result.addedScopes.length > 0 ? ` New scopes: ${result.addedScopes.join(", ")}.` : "";
      toast.success(
        `Plugin manifest updated from v${result.priorVersion} to v${result.version}; review required.${scopeNote}`,
      );
    } else if (result.installAction === "unchanged") {
      toast.success("Plugin manifest already matches the installed registration.");
    } else if (result.installAction === "restored") {
      toast.success("Plugin restored from backup (pending review). Re-issue API keys after approval.");
    } else {
      toast.success("Plugin registered (pending approval).");
    }
    resetInstallDialog();
    void refetch();
    void utils.plugin.list.invalidate();
  };

  const register = trpc.plugin.register.useMutation({
    onSuccess: handleInstallResult,
    onError: (e) => toast.error(e.message),
  });
  const restoreBackup = trpc.plugin.restoreBackup.useMutation({
    onSuccess: handleInstallResult,
    onError: (e) => toast.error(e.message),
  });
  const saving = register.isPending || restoreBackup.isPending;

  return (
    <>
      <Topbar
        title="Plugins"
        subtitle="Extensible agents with scoped access to your workspace. Install, update, approve, configure, or suspend plugins."
        actions={
          <Button variant="ember" size="sm" onClick={() => setRegisterOpen(true)}>
            Install/update plugin
          </Button>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
          <Card>
            {(plugins ?? []).map((p) => (
              <li key={p.id} className="flex items-start gap-4 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/w/${ws.slug}/settings/plugins/${p.id}`}
                      className="font-medium hover:text-ember"
                    >
                      {p.name}
                    </Link>
                    <Badge color={statusTone[p.status]}>{p.status}</Badge>
                    <span className="font-mono text-[0.6875rem] text-muted-foreground">
                      v{p.version} · {p.slug}
                    </span>
                  </div>
                  {p.description && (
                    <div className="mt-1 text-xs text-muted-foreground">{p.description}</div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-1 text-meta">
                    <span className="text-muted-foreground">scopes</span>
                    {p.scopes.map((s) => (
                      <Badge key={s}>{s}</Badge>
                    ))}
                  </div>
                  {p.skills.length > 0 && (
                    <div className="mt-2 text-[0.6875rem] text-muted-foreground">
                      <span className="uppercase tracking-wider">Skills: </span>
                      {p.skills.map((s) => s.name).join(", ")}
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  {p.status === "PENDING" && (
                    <Button
                      variant="ember"
                      size="sm"
                      onClick={() => approve.mutate({ id: p.id })}
                    >
                      Approve
                    </Button>
                  )}
                  {p.status === "APPROVED" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => suspend.mutate({ id: p.id })}
                    >
                      Suspend
                    </Button>
                  )}
                  <Link href={`/w/${ws.slug}/settings/plugins/${p.id}`}>
                    <Button variant="ghost" size="sm" className="w-full">
                      Details
                    </Button>
                  </Link>
                </div>
              </li>
            ))}
            {plugins?.length === 0 && (
              <EmptyState
                icon={Puzzle}
                title="No plugins yet"
                hint="Register a plugin manifest to extend Forge with scoped tools and skills."
              />
            )}
          </Card>

          {/* Permission reference — what each manifest scope grants. Reviewers
              should approve the smallest set that does the job. Mirrors the
              real PluginScope enum (prisma/schema.prisma). */}
          <section className="space-y-2">
            <div className="px-1">
              <h2 className="text-[0.8125rem] font-semibold text-foreground">
                Permission reference
              </h2>
              <p className="mt-0.5 text-meta text-muted-foreground">
                Scopes a plugin manifest can request. Approve the smallest set that
                does the job.
              </p>
            </div>
            <Card as="div">
              <ul className="grid grid-cols-1 gap-3 p-4 text-meta sm:grid-cols-2 lg:grid-cols-3">
                {PLUGIN_SCOPE_ORDER.map((scope) => (
                  <li key={scope}>
                    <div className="font-mono text-[0.6875rem] text-ember">{scope}</div>
                    <div className="mt-0.5 text-muted-foreground">
                      {PLUGIN_SCOPE_HELP[scope]}
                    </div>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        </div>
      </div>

      <Dialog open={registerOpen} onClose={() => setRegisterOpen(false)} className="max-w-2xl">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            try {
              const parsed = JSON.parse(rawManifest);
              if (
                parsed &&
                typeof parsed === "object" &&
                (parsed as { kind?: unknown }).kind === "forge.plugin.backup"
              ) {
                restoreBackup.mutate({ backup: parsed });
              } else {
                register.mutate({ manifest: parsed, webhookUrl: webhookUrl || undefined });
              }
            } catch {
              toast.error("Manifest or backup is not valid JSON.");
            }
          }}
          className="space-y-3 p-5"
        >
          <div className="text-sm font-semibold">Install, update, or restore plugin</div>
          <p className="text-meta text-muted-foreground">
            Re-submit a manifest with the same slug to update version, scopes, skills, or webhook
            configuration, or paste a Forge plugin backup to restore it. Forge preserves existing
            keys on updates; backup restores require review and new API keys.
          </p>
          <label className="block text-xs text-muted-foreground">Manifest or backup (JSON)</label>
          <textarea
            value={rawManifest}
            onChange={(e) => setRawManifest(e.target.value)}
            placeholder='{"schemaVersion":1,"slug":"issue-triage","name":"Issue Triage","version":"0.1.0","scopes":["READ_ISSUES","WRITE_ISSUES"]}'
            className="focus-ring h-56 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          />
          <label className="block text-xs text-muted-foreground">Webhook URL (optional)</label>
          <Input
            value={webhookUrl}
            onChange={(e) => setWebhookUrl(e.target.value)}
            placeholder="https://plugin.example.com/forge"
          />
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => setRegisterOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="ember" disabled={saving}>
              {saving ? "Saving…" : "Install/update/restore"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
