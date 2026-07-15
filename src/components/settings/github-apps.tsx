"use client";
import { useEffect, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import {
  Github,
  Plus,
  Trash2,
  ShieldCheck,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Pencil,
  Webhook,
} from "lucide-react";
import { Section } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm, QuickForm } from "@/components/ui/modal";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

type VerifyResult = {
  account: string | null;
  repositorySelection: string | null;
  repoCount: number | null;
};

/**
 * Workspace GitHub Apps — shared git auth for runtimes. Create one via the
 * manifest flow (GitHub generates the key, no paste) or by pasting credentials,
 * install it on your org, and point runtimes at it. The same app can provide
 * realtime issue/PR sync and short-lived runtime GH_TOKEN credentials.
 */
export function GithubAppsManager() {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { data: apps, isLoading } = trpc.githubApp.list.useQuery();

  const [showManual, setShowManual] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, VerifyResult>>({});
  const [manifestOpen, setManifestOpen] = useState(false);
  const [appName, setAppName] = useState("");
  const [appOrg, setAppOrg] = useState("");

  // Surface manifest-flow outcomes carried back as query params.
  useEffect(() => {
    const err = searchParams.get("github_app_error");
    const installed = searchParams.get("github_app_installed");
    const created = searchParams.get("github_app_created");
    if (err) toast.error(err);
    else if (installed) toast.success("GitHub App installed");
    else if (created) toast.success("GitHub App created — install it to finish");
    if (err || installed || created) {
      void utils.githubApp.list.invalidate();
      window.history.replaceState(null, "", pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const invalidate = () => void utils.githubApp.list.invalidate();

  const openManifest = () => {
    setAppName(`Forge ${ws.key}`);
    setAppOrg("");
    setManifestOpen(true);
  };
  const submitManifest = () => {
    const url = new URL("/api/integrations/github-app/manifest", window.location.origin);
    url.searchParams.set("ws", ws.id);
    url.searchParams.set("returnTo", pathname);
    if (appName.trim()) url.searchParams.set("name", appName.trim());
    if (appOrg.trim()) url.searchParams.set("org", appOrg.trim());
    window.location.href = url.toString();
  };

  return (
    <Section
      title={
        <span className="flex items-center gap-2">
          <Github className="h-3.5 w-3.5 text-muted-foreground" />
          GitHub Apps
          <span className="font-mono text-meta text-muted-foreground">{apps?.length ?? 0}</span>
        </span>
      }
      hint="One workspace GitHub App for realtime issue/PR sync and runtime git auth. Forge verifies signed webhooks and mints short-lived GH_TOKEN credentials without per-repo keys."
    >
      <Card as="div" className="divide-y-0 p-0">
        {isLoading ? (
          <div className="px-4 py-6 text-meta text-muted-foreground">Loading…</div>
        ) : apps && apps.length > 0 ? (
          <ul className="divide-y divide-border">
            {apps.map((a) => (
              <AppRow
                key={a.id}
                app={a}
                testResult={testResults[a.id]}
                onTested={(r) => setTestResults((m) => ({ ...m, [a.id]: r }))}
                onChanged={invalidate}
              />
            ))}
          </ul>
        ) : (
          <div className="px-4 py-6 text-meta text-muted-foreground">
            No GitHub Apps yet. Create one with GitHub (recommended — no key to paste) or add an
            existing app&apos;s credentials manually.
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
          <Button type="button" size="sm" onClick={openManifest}>
            <Github className="h-3.5 w-3.5" />
            Create with GitHub
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setShowManual((v) => !v)}
          >
            <Plus className="h-3.5 w-3.5" />
            Add manually
          </Button>
          <span className="text-meta text-muted-foreground">
            “Create with GitHub” generates the app + key for you, then walks you through install.
          </span>
        </div>

        {showManual && <ManualForm onDone={() => { setShowManual(false); invalidate(); }} />}
      </Card>

      <QuickForm
        open={manifestOpen}
        onOpenChange={setManifestOpen}
        title="Create a GitHub App"
        description="Created on your account — you can rename it on GitHub afterward. Next you'll approve it on GitHub, then install it."
        primaryLabel="Continue on GitHub"
        onSubmit={() => submitManifest()}
      >
        <QuickForm.Field label="App name" htmlFor="gh-app-name">
          <Input
            id="gh-app-name"
            value={appName}
            onChange={(e) => setAppName(e.target.value)}
            autoFocus
          />
        </QuickForm.Field>
        <QuickForm.Field
          label="GitHub organization"
          htmlFor="gh-app-org"
          hint="Leave blank to install under your personal account."
        >
          <Input
            id="gh-app-org"
            value={appOrg}
            onChange={(e) => setAppOrg(e.target.value)}
            placeholder="my-org (optional)"
          />
        </QuickForm.Field>
      </QuickForm>
    </Section>
  );
}

type AppListItem = {
  id: string;
  name: string;
  appId: string;
  installationId: string | null;
  slug: string | null;
  createdViaManifest: boolean;
  lastMintedAt: Date | string | null;
  lastError: string | null;
  webhookConfiguredAt: Date | string | null;
  webhookLastError: string | null;
  runtimeCount: number;
  installed: boolean;
};

function AppRow({
  app,
  testResult,
  onTested,
  onChanged,
}: {
  app: AppListItem;
  testResult: VerifyResult | undefined;
  onTested: (r: VerifyResult) => void;
  onChanged: () => void;
}) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [editing, setEditing] = useState(false);

  const test = trpc.githubApp.test.useMutation({
    onSuccess: (r) => {
      onTested(r);
      onChanged();
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
  const remove = trpc.githubApp.delete.useMutation({
    onSuccess: () => {
      setConfirmRemove(false);
      onChanged();
      toast.success("GitHub App removed");
    },
    onError: (e) => toast.error(e.message),
  });
  const configureWebhook = trpc.githubApp.configureWebhook.useMutation({
    onSuccess: (result) => {
      onChanged();
      if (result.readiness?.ready) toast.success("GitHub realtime sync enabled");
      else
        toast.warning("Webhook endpoint secured; review the App events and permissions on GitHub");
    },
    onError: (e) => toast.error(e.message),
  });

  const installHref = app.slug
    ? `https://github.com/apps/${app.slug}/installations/new`
    : null;

  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium text-foreground">{app.name}</span>
        {app.installed ? (
          <span className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-emerald-700 dark:text-emerald-400">
            installed
          </span>
        ) : (
          <span className="rounded-md border border-amber-600/30 bg-amber-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-700 dark:text-amber-500">
            not installed
          </span>
        )}
        {app.createdViaManifest && (
          <span className="text-[0.625rem] text-muted-foreground">via GitHub</span>
        )}
        {app.webhookConfiguredAt && !app.webhookLastError ? (
          <span className="rounded-md border border-emerald-600/30 bg-emerald-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-emerald-700 dark:text-emerald-400">
            realtime sync
          </span>
        ) : app.webhookLastError ? (
          <span className="rounded-md border border-amber-600/30 bg-amber-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-700 dark:text-amber-500">
            action required
          </span>
        ) : (
          <span className="rounded-md border border-amber-600/30 bg-amber-600/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-700 dark:text-amber-500">
            polling only
          </span>
        )}
        <span className="ml-auto text-meta text-muted-foreground/70">
          {app.runtimeCount} runtime{app.runtimeCount === 1 ? "" : "s"}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-meta text-muted-foreground/80">
        <span>
          App ID <span className="font-mono text-foreground">{app.appId}</span>
        </span>
        {app.installationId && (
          <span>
            Installation <span className="font-mono text-foreground">{app.installationId}</span>
          </span>
        )}
        {app.slug && <span className="font-mono">{app.slug}</span>}
      </div>

      <HealthLine
        lastMintedAt={app.lastMintedAt}
        lastError={app.lastError}
        testResult={testResult}
      />
      {app.webhookLastError && (
        <div className="flex flex-wrap items-start gap-2 text-meta text-amber-700 dark:text-amber-500">
          <p className="inline-flex items-start gap-1.5">
            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            Webhook: {app.webhookLastError}
          </p>
          {app.slug && (
            <a
              href={`https://github.com/apps/${app.slug}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline underline-offset-2"
            >
              Review App settings
              <ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => test.mutate({ id: app.id })}
          disabled={test.isPending || !app.installed}
          title={app.installed ? "Test connection" : "Install the app first"}
        >
          {test.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ShieldCheck className="h-3.5 w-3.5" />
          )}
          Test connection
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => configureWebhook.mutate({ id: app.id })}
          disabled={configureWebhook.isPending || !app.installed}
          title={
            app.installed
              ? "Configure Forge as this app's signed webhook endpoint"
              : "Install the app first"
          }
        >
          {configureWebhook.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Webhook className="h-3.5 w-3.5" />
          )}
          {app.webhookConfiguredAt ? "Rotate webhook secret" : "Enable realtime sync"}
        </Button>
        {installHref && (
          <a
            href={installHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
          >
            {app.installed ? "Manage repos on GitHub" : "Install on GitHub"}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
        >
          <Pencil className="h-3 w-3" />
          Edit
        </button>
        <button
          type="button"
          onClick={() => setConfirmRemove(true)}
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-meta text-muted-foreground hover:bg-subtle hover:text-destructive"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Remove
        </button>
      </div>

      {editing && (
        <EditForm
          app={app}
          onDone={() => {
            setEditing(false);
            onChanged();
          }}
        />
      )}

      <Confirm
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title={`Remove ${app.name}?`}
        description="Runtimes using this app are unlinked and fall back to a static GH_TOKEN secret on their next provision. This does not delete the app on GitHub."
        primaryLabel="Remove"
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ id: app.id })}
      />
    </li>
  );
}

function HealthLine({
  lastMintedAt,
  lastError,
  testResult,
}: {
  lastMintedAt: Date | string | null;
  lastError: string | null;
  testResult: VerifyResult | undefined;
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
        Connected{testResult.account ? ` for ${testResult.account}` : ""} — {repos}, token valid ~1h.
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
  return null;
}

function ManualForm({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [appId, setAppId] = useState("");
  const [installationId, setInstallationId] = useState("");
  const [slug, setSlug] = useState("");
  const [privateKey, setPrivateKey] = useState("");

  const create = trpc.githubApp.createManual.useMutation({
    onSuccess: () => {
      toast.success("GitHub App added");
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-3 border-t border-border bg-subtle/20 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!name.trim() || !appId.trim() || !installationId.trim() || !privateKey.trim()) {
          toast.error("Name, App ID, Installation ID, and private key are required.");
          return;
        }
        create.mutate({
          name: name.trim(),
          appId: appId.trim(),
          installationId: installationId.trim(),
          slug: slug.trim() || undefined,
          privateKey: privateKey.trim(),
        });
      }}
    >
      <p className="text-meta text-muted-foreground">
        Add an existing GitHub App. Need its App ID + Installation ID (from the install URL) + a
        generated private key.
      </p>
      <div className="flex flex-wrap gap-2">
        <LabeledInput label="Name" value={name} onChange={setName} placeholder="Axiom Bot" />
        <LabeledInput label="App ID" value={appId} onChange={setAppId} placeholder="123456" mono />
        <LabeledInput
          label="Installation ID"
          value={installationId}
          onChange={setInstallationId}
          placeholder="87654321"
          mono
        />
        <LabeledInput
          label="App slug (optional)"
          value={slug}
          onChange={(v) => setSlug(v.toLowerCase())}
          placeholder="forge-bot"
          mono
        />
      </div>
      <label className="block space-y-1">
        <span className="text-meta text-muted-foreground">Private key (PEM)</span>
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
      <Button type="submit" size="sm" disabled={create.isPending}>
        <Plus className="h-3.5 w-3.5" />
        Add app
      </Button>
    </form>
  );
}

function EditForm({ app, onDone }: { app: AppListItem; onDone: () => void }) {
  const [name, setName] = useState(app.name);
  const [appId, setAppId] = useState(app.appId);
  const [installationId, setInstallationId] = useState(app.installationId ?? "");
  const [slug, setSlug] = useState(app.slug ?? "");
  const [privateKey, setPrivateKey] = useState("");

  const update = trpc.githubApp.update.useMutation({
    onSuccess: () => {
      toast.success("GitHub App updated");
      onDone();
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <form
      className="space-y-3 rounded-md border border-border bg-subtle/20 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        update.mutate({
          id: app.id,
          name: name.trim() || undefined,
          appId: appId.trim() || undefined,
          installationId: installationId.trim() || undefined,
          slug: slug.trim() || "",
          privateKey: privateKey.trim() || undefined,
        });
      }}
    >
      <p className="text-meta text-muted-foreground">
        Editing — leave the private key blank to keep the stored one.
      </p>
      <div className="flex flex-wrap gap-2">
        <LabeledInput label="Name" value={name} onChange={setName} />
        <LabeledInput label="App ID" value={appId} onChange={setAppId} mono />
        <LabeledInput
          label="Installation ID"
          value={installationId}
          onChange={setInstallationId}
          mono
        />
        <LabeledInput label="App slug" value={slug} onChange={(v) => setSlug(v.toLowerCase())} mono />
      </div>
      <label className="block space-y-1">
        <span className="text-meta text-muted-foreground">Private key (PEM) — blank keeps current</span>
        <textarea
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          rows={3}
          spellCheck={false}
          className="focus-ring w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-[0.75rem] leading-snug text-foreground placeholder:text-muted-foreground"
          aria-label="GitHub App private key (PEM)"
        />
      </label>
      <Button type="submit" size="sm" disabled={update.isPending}>
        Save changes
      </Button>
    </form>
  );
}

function LabeledInput({
  label,
  value,
  onChange,
  placeholder,
  mono,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
}) {
  return (
    <label className="flex-1 space-y-1" style={{ minWidth: "9rem" }}>
      <span className="text-meta text-muted-foreground">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? "font-mono" : undefined}
        aria-label={label}
      />
    </label>
  );
}
