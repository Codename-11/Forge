"use client";
import { useState } from "react";
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
  Loader2,
} from "lucide-react";
import { Section } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

/**
 * Runtime credentials: a GitHub App (the recommended git auth — install once,
 * manage repos in GitHub), encrypted secrets injected into the runtime at
 * provision time, and the repos it clone-or-pulls into its workspace. Secret
 * and key values are write-only — the API never returns them. The runtime
 * reads its own decrypted values via the `runtimes.provisioning` MCP tool.
 */
export function RuntimeCredentials({ runtimeId }: { runtimeId: string }) {
  const { data: githubApp } = trpc.runtime.getGithubApp.useQuery({ runtimeId });
  return (
    <>
      <GithubAppSection runtimeId={runtimeId} />
      <SecretsSection runtimeId={runtimeId} githubAppActive={!!githubApp} />
      <ReposSection runtimeId={runtimeId} />
    </>
  );
}

type VerifyResult = {
  slug: string | null;
  appName: string | null;
  account: string | null;
  expiresAt: string;
  repositorySelection: string | null;
  repoCount: number | null;
};

function GithubAppSection({ runtimeId }: { runtimeId: string }) {
  const utils = trpc.useUtils();
  const { data: app, isLoading } = trpc.runtime.getGithubApp.useQuery({ runtimeId });

  const [editing, setEditing] = useState(false);
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [slug, setSlug] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [testResult, setTestResult] = useState<VerifyResult | null>(null);

  const configured = !!app;
  const showForm = !configured || editing;

  const invalidate = () => void utils.runtime.getGithubApp.invalidate({ runtimeId });

  const resetForm = () => {
    setAppId("");
    setInstallationId("");
    setSlug("");
    setPrivateKey("");
  };

  const save = trpc.runtime.setGithubApp.useMutation({
    onSuccess: () => {
      invalidate();
      setEditing(false);
      resetForm();
      setTestResult(null);
      toast.success("GitHub App saved");
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.runtime.deleteGithubApp.useMutation({
    onSuccess: () => {
      invalidate();
      setConfirmRemove(false);
      setTestResult(null);
      toast.success("GitHub App removed");
    },
    onError: (e) => toast.error(e.message),
  });
  const test = trpc.runtime.testGithubApp.useMutation({
    onSuccess: (r) => {
      setTestResult(r);
      invalidate();
      const where = r.account ? ` for ${r.account}` : "";
      const repos =
        r.repoCount != null
          ? `${r.repoCount} repo${r.repoCount === 1 ? "" : "s"}`
          : r.repositorySelection === "all"
            ? "all repos"
            : "selected repos";
      toast.success(`Connected${where} — ${repos}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const startEdit = () => {
    setAppId(app?.appId ?? "");
    setInstallationId(app?.installationId ?? "");
    setSlug(app?.slug ?? "");
    setPrivateKey("");
    setEditing(true);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!appId.trim() || !installationId.trim()) return;
    if (!configured && !privateKey.trim()) {
      toast.error("A private key is required to set up the app.");
      return;
    }
    save.mutate({
      runtimeId,
      appId: appId.trim(),
      installationId: installationId.trim(),
      slug: slug.trim() || undefined,
      privateKey: privateKey.trim() || undefined,
    });
  };

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Github className="h-3.5 w-3.5 text-muted-foreground" />
          GitHub App
          {configured && (
            <span className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-emerald-700 dark:text-emerald-400">
              linked
            </span>
          )}
        </span>
      }
      hint="Install one GitHub App and let Forge mint a short-lived token into GH_TOKEN at provision time. Manage which repos it can touch from GitHub — no per-repo tokens, no key to rotate."
    >
      <Card as="div" className="space-y-0 p-0">
        {isLoading ? (
          <div className="px-4 py-6 text-meta text-muted-foreground">Loading…</div>
        ) : (
          <>
            {configured && (
              <div className="space-y-2 px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <Field label="App ID" value={app!.appId} />
                  <Field label="Installation" value={app!.installationId} />
                  {app!.slug && <Field label="App" value={app!.slug} />}
                  <span className="inline-flex items-center gap-1 text-meta text-muted-foreground">
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                    private key set
                  </span>
                </div>
                <HealthLine
                  lastMintedAt={app!.lastMintedAt}
                  lastError={app!.lastError}
                  testResult={testResult}
                />
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => test.mutate({ runtimeId })}
                    disabled={test.isPending}
                  >
                    {test.isPending ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <ShieldCheck className="h-3.5 w-3.5" />
                    )}
                    Test connection
                  </Button>
                  {!editing && (
                    <Button type="button" size="sm" variant="ghost" onClick={startEdit}>
                      Edit
                    </Button>
                  )}
                  {app!.slug && (
                    <a
                      href={`https://github.com/apps/${app!.slug}/installations/new`}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
                    >
                      Add repositories on GitHub
                      <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  <button
                    type="button"
                    onClick={() => setConfirmRemove(true)}
                    className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-meta text-muted-foreground hover:bg-subtle hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remove
                  </button>
                </div>
              </div>
            )}

            {!configured && <SetupGuide />}

            {showForm && (
              <form
                onSubmit={submit}
                className={cn(
                  "space-y-3 px-4 py-3",
                  configured && "border-t border-border bg-subtle/20",
                )}
              >
                {configured && (
                  <p className="text-meta text-muted-foreground">
                    Editing — leave the private key blank to keep the stored one.
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <label className="flex-1 space-y-1">
                    <span className="text-meta text-muted-foreground">App ID</span>
                    <Input
                      value={appId}
                      onChange={(e) => setAppId(e.target.value)}
                      placeholder="123456"
                      inputMode="numeric"
                      className="font-mono"
                      aria-label="GitHub App ID"
                    />
                  </label>
                  <label className="flex-1 space-y-1">
                    <span className="text-meta text-muted-foreground">Installation ID</span>
                    <Input
                      value={installationId}
                      onChange={(e) => setInstallationId(e.target.value)}
                      placeholder="87654321"
                      inputMode="numeric"
                      className="font-mono"
                      aria-label="GitHub App installation ID"
                    />
                  </label>
                  <label className="flex-1 space-y-1">
                    <span className="text-meta text-muted-foreground">App slug (optional)</span>
                    <Input
                      value={slug}
                      onChange={(e) => setSlug(e.target.value.toLowerCase())}
                      placeholder="forge-bot"
                      className="font-mono"
                      aria-label="GitHub App slug"
                    />
                  </label>
                </div>
                <label className="block space-y-1">
                  <span className="text-meta text-muted-foreground">
                    Private key (PEM){configured && " — leave blank to keep current"}
                  </span>
                  <textarea
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
                    rows={4}
                    spellCheck={false}
                    className="focus-ring w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[0.75rem] leading-snug text-foreground placeholder:text-muted-foreground"
                    aria-label="GitHub App private key (PEM)"
                  />
                </label>
                <div className="flex items-center gap-2">
                  <Button
                    type="submit"
                    size="sm"
                    disabled={save.isPending || !appId.trim() || !installationId.trim()}
                  >
                    <Plus className="h-3.5 w-3.5" />
                    {configured ? "Save changes" : "Link GitHub App"}
                  </Button>
                  {configured && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setEditing(false);
                        resetForm();
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </form>
            )}
          </>
        )}
      </Card>

      <Confirm
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove GitHub App?"
        description="The runtime stops minting GH_TOKEN from this app on its next provision. Add a GH_TOKEN secret or another app to restore git access."
        primaryLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ runtimeId })}
      />
    </Section>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span className="text-meta text-muted-foreground/70">{label}</span>
      <span className="font-mono text-id text-foreground">{value}</span>
    </span>
  );
}

function HealthLine({
  lastMintedAt,
  lastError,
  testResult,
}: {
  lastMintedAt: Date | string | null;
  lastError: string | null;
  testResult: VerifyResult | null;
}) {
  if (testResult) {
    const repos =
      testResult.repoCount != null
        ? `${testResult.repoCount} repo${testResult.repoCount === 1 ? "" : "s"}`
        : testResult.repositorySelection === "all"
          ? "all repos"
          : "selected repos";
    return (
      <p className="inline-flex items-center gap-1.5 text-meta text-emerald-700 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" />
        Connected{testResult.account ? ` for ${testResult.account}` : ""} — {repos}, token valid
        ~1h.
      </p>
    );
  }
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
      <p className="text-meta text-muted-foreground/80">
        Last token minted {relativeTime(lastMintedAt)}.
      </p>
    );
  }
  return (
    <p className="text-meta text-muted-foreground/80">
      Not yet used — run “Test connection” to verify.
    </p>
  );
}

function SetupGuide() {
  return (
    <div className="space-y-2 border-b border-border bg-subtle/20 px-4 py-3 text-meta text-muted-foreground">
      <p className="text-foreground">One-time setup:</p>
      <ol className="ml-4 list-decimal space-y-1.5">
        <li>
          <a
            href="https://github.com/settings/apps/new"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground"
          >
            Create a GitHub App
            <ExternalLink className="h-3 w-3" />
          </a>{" "}
          with repository permissions <span className="font-mono">Contents: Read &amp; write</span>
          , <span className="font-mono">Pull requests: Read &amp; write</span>,{" "}
          <span className="font-mono">Metadata: Read</span>. Generate &amp; download a private key.
        </li>
        <li>
          Install the app on your account/org and choose which repos it can access. The install
          URL ends in <span className="font-mono">/installations/&lt;id&gt;</span> — that number is
          the Installation ID.
        </li>
        <li>Paste the App ID, Installation ID, and private key below, then “Test connection”.</li>
      </ol>
    </div>
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
      hint="Encrypted env injected into this runtime when it provisions (e.g. GH_TOKEN). Values are write-only — never shown again after saving."
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
                automatically. Add secrets only for other env (deploy creds, registry tokens, …).
              </>
            ) : (
              <>
                No secrets yet. Add a <span className="font-mono">GH_TOKEN</span> to give this
                runtime git/gh access — or link a GitHub App above to skip per-repo tokens.
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
      hint="Repos this runtime clone-or-pulls into its workspace before an agent's turn (auth from the secrets above). The agent lands in a ready checkout."
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
            No repos bound yet. Add one so the runtime materializes it automatically.
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
