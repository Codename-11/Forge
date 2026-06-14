"use client";
import { useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  KeyRound,
  GitBranch,
  Trash2,
  Plus,
  Github,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
} from "lucide-react";
import { Section } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/modal";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Runtime credentials: which workspace GitHub App this runtime uses for git
 * auth (managed at Settings → GitHub Apps), encrypted secrets injected at
 * provision time, and the repos it clone-or-pulls. Secret values are
 * write-only — the API never returns them. The runtime reads its own decrypted
 * values via the `runtimes.provisioning` MCP tool.
 */
export function RuntimeCredentials({ runtimeId }: { runtimeId: string }) {
  const { data: linkedApp } = trpc.runtime.getGithubApp.useQuery({ runtimeId });
  const appActive = !!linkedApp?.installationId;
  return (
    <>
      <GithubAppSection runtimeId={runtimeId} />
      <SecretsSection runtimeId={runtimeId} githubAppActive={appActive} />
      <ReposSection runtimeId={runtimeId} />
    </>
  );
}

/**
 * Selector: pick which workspace GitHub App (if any) this runtime uses. Apps
 * are created/installed/tested on the workspace GitHub Apps page; here you just
 * point a runtime at one (or none → fall back to a static GH_TOKEN secret).
 */
function GithubAppSection({ runtimeId }: { runtimeId: string }) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const { data: linked } = trpc.runtime.getGithubApp.useQuery({ runtimeId });
  const { data: apps, isLoading } = trpc.githubApp.list.useQuery();

  const link = trpc.runtime.linkGithubApp.useMutation({
    onSuccess: () => {
      void utils.runtime.getGithubApp.invalidate({ runtimeId });
      toast.success("GitHub App updated");
    },
    onError: (e) => toast.error(e.message),
  });

  const manageHref = `/w/${ws.slug}/settings/github-apps`;

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Github className="h-3.5 w-3.5 text-muted-foreground" />
          GitHub App
          {linked && (
            <span className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-emerald-700 dark:text-emerald-400">
              {linked.installationId ? "linked" : "not installed"}
            </span>
          )}
        </span>
      }
      hint="Use a shared GitHub App for git auth — Forge mints a short-lived token into GH_TOKEN at provision time, no per-repo key. Manage apps on the GitHub Apps page."
    >
      <Card as="div" className="space-y-3 p-4">
        {isLoading ? (
          <div className="text-meta text-muted-foreground">Loading…</div>
        ) : apps && apps.length > 0 ? (
          <>
            <label className="block space-y-1">
              <span className="text-meta text-muted-foreground">App used by this runtime</span>
              <select
                value={linked ? (apps.find((a) => a.appId === linked.appId)?.id ?? "") : ""}
                onChange={(e) => link.mutate({ runtimeId, githubAppId: e.target.value || null })}
                disabled={link.isPending}
                className="focus-ring h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground"
                aria-label="GitHub App"
              >
                <option value="">None — use a static GH_TOKEN secret</option>
                {apps.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.installed ? "" : " (not installed)"}
                  </option>
                ))}
              </select>
            </label>
            {linked && (
              <HealthLine lastMintedAt={linked.lastMintedAt} lastError={linked.lastError} />
            )}
            <Link
              href={manageHref}
              className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
            >
              Manage GitHub Apps
              <ExternalLink className="h-3 w-3" />
            </Link>
          </>
        ) : (
          <div className="space-y-2 text-meta text-muted-foreground">
            <p>
              No GitHub App in this workspace yet. Create one to give runtimes push/PR access
              without per-repo tokens.
            </p>
            <Link href={manageHref}>
              <Button type="button" size="sm" variant="outline">
                <Plus className="h-3.5 w-3.5" />
                Set up a GitHub App
              </Button>
            </Link>
          </div>
        )}
      </Card>
    </Section>
  );
}

function HealthLine({
  lastMintedAt,
  lastError,
}: {
  lastMintedAt: Date | string | null;
  lastError: string | null;
}) {
  if (lastError) {
    return (
      <p className="inline-flex items-start gap-1.5 text-meta text-destructive">
        <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        {lastError}
      </p>
    );
  }
  if (lastMintedAt) {
    return (
      <p className="inline-flex items-center gap-1.5 text-meta text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Last token minted {relativeTime(lastMintedAt)}.
      </p>
    );
  }
  return (
    <p className="text-meta text-muted-foreground/80">
      Linked — a token mints on this runtime&apos;s next provision.
    </p>
  );
}

function SecretsSection({
  runtimeId,
  githubAppActive,
}: {
  runtimeId: string;
  githubAppActive: boolean;
}) {
  const utils = trpc.useUtils();
  const { data: secrets, isLoading } = trpc.runtime.listSecrets.useQuery({ runtimeId });
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [toDelete, setToDelete] = useState<string | null>(null);

  const invalidate = () => void utils.runtime.listSecrets.invalidate({ runtimeId });
  const setSecret = trpc.runtime.setSecret.useMutation({
    onSuccess: () => {
      invalidate();
      setKey("");
      setValue("");
      setDescription("");
      toast.success("Secret saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteSecret = trpc.runtime.deleteSecret.useMutation({
    onSuccess: () => {
      invalidate();
      setToDelete(null);
      toast.success("Secret removed");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
          Secrets
          <span className="font-mono text-meta text-muted-foreground">
            {secrets?.length ?? 0}
          </span>
        </span>
      }
      hint="Encrypted env injected into this runtime when it provisions (e.g. GH_TOKEN, GIT_SSH_KEY). Values are write-only — never shown again after saving."
    >
      <Card as="div" className="divide-y-0 p-0">
        {githubAppActive && (
          <div className="flex items-start gap-2 border-b border-border bg-subtle/30 px-4 py-2.5 text-meta text-muted-foreground">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>
              A GitHub App is linked, so <span className="font-mono">GH_TOKEN</span> is minted
              automatically at provision time — any <span className="font-mono">GH_TOKEN</span>{" "}
              secret set here is ignored in favor of it.
            </span>
          </div>
        )}
        {isLoading ? (
          <div className="px-4 py-6 text-meta text-muted-foreground">Loading…</div>
        ) : secrets && secrets.length > 0 ? (
          <ul className="divide-y divide-border">
            {secrets.map((s) => (
              <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-id text-foreground">{s.key}</span>
                  {s.description && (
                    <span className="ml-2 text-meta text-muted-foreground">{s.description}</span>
                  )}
                  <div className="text-meta text-muted-foreground/60">
                    updated {relativeTime(s.updatedAt)}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setToDelete(s.key)}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-subtle hover:text-destructive"
                  title="Remove secret"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-meta text-muted-foreground">
            {githubAppActive ? (
              <>
                No secrets yet — and you don&apos;t need a{" "}
                <span className="font-mono">GH_TOKEN</span> here: the GitHub App above mints one
                automatically. Add secrets only for other env (deploy creds, registry tokens,
                a <span className="font-mono">GIT_SSH_KEY</span>, …).
              </>
            ) : (
              <>
                No secrets yet. Add a <span className="font-mono">GH_TOKEN</span> (or a{" "}
                <span className="font-mono">GIT_SSH_KEY</span>) to give this runtime git access —
                or link a GitHub App above to skip per-repo tokens.
              </>
            )}
          </div>
        )}
        <form
          className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!key.trim() || !value) return;
            setSecret.mutate({
              runtimeId,
              key: key.trim(),
              value,
              description: description.trim() || undefined,
            });
          }}
        >
          <Input
            value={key}
            onChange={(e) => setKey(e.target.value.toUpperCase())}
            placeholder="GH_TOKEN"
            className="w-40 font-mono"
            aria-label="Secret name"
          />
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value (write-only)"
            type="password"
            className="min-w-0 flex-1"
            aria-label="Secret value"
          />
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="note (optional)"
            className="w-36"
            aria-label="Secret description"
          />
          <Button type="submit" size="sm" disabled={setSecret.isPending || !key.trim() || !value}>
            <Plus className="h-3.5 w-3.5" />
            Save
          </Button>
        </form>
      </Card>

      <Confirm
        open={toDelete !== null}
        onOpenChange={(v) => !v && setToDelete(null)}
        title={`Remove ${toDelete ?? "secret"}?`}
        description="The runtime loses this value on its next provision. This can't be undone."
        primaryLabel="Remove"
        loading={deleteSecret.isPending}
        onConfirm={() => {
          if (toDelete) deleteSecret.mutate({ runtimeId, key: toDelete });
        }}
      />
    </Section>
  );
}

function ReposSection({ runtimeId }: { runtimeId: string }) {
  const utils = trpc.useUtils();
  const { data: repos, isLoading } = trpc.runtime.listRepos.useQuery({ runtimeId });
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("");
  const [path, setPath] = useState("");
  const [toDelete, setToDelete] = useState<{ id: string; path: string } | null>(null);

  const invalidate = () => void utils.runtime.listRepos.invalidate({ runtimeId });
  const setRepo = trpc.runtime.setRepo.useMutation({
    onSuccess: () => {
      invalidate();
      setUrl("");
      setBranch("");
      setPath("");
      toast.success("Repo saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const deleteRepo = trpc.runtime.deleteRepo.useMutation({
    onSuccess: () => {
      invalidate();
      setToDelete(null);
      toast.success("Repo removed");
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
          Repositories
          <span className="font-mono text-meta text-muted-foreground">{repos?.length ?? 0}</span>
        </span>
      }
      hint="Repos this runtime always clone-or-pulls (auth from the GitHub App / secrets above). Project-bound repos are materialized automatically — add one here only for runtime-wide repos."
    >
      <Card as="div" className="divide-y-0 p-0">
        {isLoading ? (
          <div className="px-4 py-6 text-meta text-muted-foreground">Loading…</div>
        ) : repos && repos.length > 0 ? (
          <ul className="divide-y divide-border">
            {repos.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-id text-foreground">{r.path}</span>
                  {r.branch && (
                    <span className="ml-2 rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] text-muted-foreground">
                      {r.branch}
                    </span>
                  )}
                  <div className="truncate text-meta text-muted-foreground/80">{r.url}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setToDelete({ id: r.id, path: r.path })}
                  className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-subtle hover:text-destructive"
                  title="Remove repo"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-meta text-muted-foreground">
            No runtime-wide repos. Bind repos to projects instead (Project → Settings) so the
            right one is cloned per dispatch.
          </div>
        )}
        <form
          className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!url.trim() || !path.trim()) return;
            setRepo.mutate({
              runtimeId,
              url: url.trim(),
              branch: branch.trim() || undefined,
              path: path.trim(),
            });
          }}
        >
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/org/repo.git"
            className="min-w-0 flex-1 font-mono"
            aria-label="Repo URL"
          />
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="path"
            className="w-28 font-mono"
            aria-label="Clone path"
          />
          <Input
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder="branch"
            className="w-28 font-mono"
            aria-label="Branch"
          />
          <Button type="submit" size="sm" disabled={setRepo.isPending || !url.trim() || !path.trim()}>
            <Plus className="h-3.5 w-3.5" />
            Save
          </Button>
        </form>
      </Card>

      <Confirm
        open={toDelete !== null}
        onOpenChange={(v) => !v && setToDelete(null)}
        title={`Remove ${toDelete?.path ?? "repo"}?`}
        description="The runtime stops materializing this repo. Existing checkouts are left in place."
        primaryLabel="Remove"
        loading={deleteRepo.isPending}
        onConfirm={() => {
          if (toDelete) deleteRepo.mutate({ runtimeId, id: toDelete.id });
        }}
      />
    </Section>
  );
}
