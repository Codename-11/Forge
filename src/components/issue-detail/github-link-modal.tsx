"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  GitPullRequest,
  Github,
  Link2,
  Loader2,
  PlugZap,
  Search,
} from "lucide-react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { CenterModal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";

const LINK_KINDS = ["RELATES_TO", "IMPLEMENTS", "REVIEWS", "SOURCE"] as const;
type LinkKind = (typeof LINK_KINDS)[number];

function kindLabel(kind: string): string {
  if (kind === "SOURCE") return "source";
  if (kind === "IMPLEMENTS") return "implements";
  if (kind === "REVIEWS") return "reviews";
  return "related";
}

function stateLabel(state: string): string {
  if (state === "merged") return "merged";
  if (state === "draft") return "draft";
  return state || "unknown";
}

type ParsedRef = {
  repoFullName: string;
  number?: number;
  type?: "ISSUE" | "PULL_REQUEST";
  url?: string;
};

/** Parse a GitHub URL, `owner/repo#123`, or bare `owner/repo`. */
function parseRef(raw: string): ParsedRef | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.includes("://") || s.startsWith("github.com")) {
    try {
      const u = new URL(s.startsWith("http") ? s : `https://${s}`);
      if (!["github.com", "www.github.com"].includes(u.hostname.toLowerCase())) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      const [owner, repo, kind, num] = parts;
      if (owner && repo && (kind === "issues" || kind === "pull") && /^\d+$/.test(num ?? "")) {
        return {
          repoFullName: `${owner}/${repo}`,
          number: Number(num),
          type: kind === "pull" ? "PULL_REQUEST" : "ISSUE",
          url: `https://github.com/${owner}/${repo}/${kind}/${num}`,
        };
      }
      if (owner && repo) return { repoFullName: `${owner}/${repo}` };
      return null;
    } catch {
      return null;
    }
  }
  const hash = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
  if (hash) return { repoFullName: `${hash[1]}/${hash[2]}`, number: Number(hash[3]) };
  const bare = s.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) return { repoFullName: `${bare[1]}/${bare[2]}` };
  return null;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return debounced;
}

/**
 * Issue-page GitHub link modal: paste a URL / `owner/repo#123`, or browse a
 * mapped repo's open issues + PRs. When `owner/repo` isn't wired up yet, the
 * URL tab explains exactly why and offers the one-click fix (map the repo,
 * resume a paused mapping, or install/connect the App) instead of a dead-end
 * "No active GitHub mapping" error.
 */
export function GitHubLinkModal({
  issueId,
  open,
  onOpenChange,
}: {
  issueId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ws = useWorkspace();
  const utils = trpc.useUtils();
  const isAdmin = ws.role === "OWNER" || ws.role === "ADMIN";
  const [tab, setTab] = useState<"url" | "browse">("url");
  const [kind, setKind] = useState<LinkKind>("RELATES_TO");

  // Reset transient state whenever the modal is (re)opened.
  useEffect(() => {
    if (open) {
      setTab("url");
      setKind("RELATES_TO");
    }
  }, [open]);

  const onLinked = (closeAfter: boolean) => {
    void utils.github.listLinked.invalidate({ issueId });
    if (closeAfter) onOpenChange(false);
  };

  return (
    <CenterModal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Github className="h-4 w-4 text-muted-foreground" />
          Link a GitHub issue or PR
        </span>
      }
      description="Paste a URL or owner/repo#123, or browse a connected repository."
      footer={
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
          Done
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-1 rounded-md border border-border bg-card/40 p-1">
          <TabButton active={tab === "url"} onClick={() => setTab("url")} icon={Link2}>
            By URL or number
          </TabButton>
          <TabButton active={tab === "browse"} onClick={() => setTab("browse")} icon={Search}>
            Browse a repo
          </TabButton>
        </div>

        <KindSelector kind={kind} onChange={setKind} />

        {tab === "url" ? (
          <ByUrlTab
            issueId={issueId}
            kind={kind}
            isAdmin={isAdmin}
            onLinked={() => onLinked(true)}
          />
        ) : (
          <BrowseTab issueId={issueId} kind={kind} isAdmin={isAdmin} onLinked={() => onLinked(false)} />
        )}
      </div>
    </CenterModal>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Link2;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "focus-ring inline-flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1.5 text-xs font-medium transition-colors " +
        (active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground")
      }
    >
      <Icon className="h-3.5 w-3.5" />
      {children}
    </button>
  );
}

function KindSelector({ kind, onChange }: { kind: LinkKind; onChange: (k: LinkKind) => void }) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">Link as</span>
      <select
        value={kind}
        onChange={(e) => onChange(e.target.value as LinkKind)}
        className="focus-ring h-7 rounded-md border border-input bg-background px-2 text-xs"
        aria-label="Link kind"
      >
        {LINK_KINDS.map((k) => (
          <option key={k} value={k}>
            {kindLabel(k)}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ───────────────────────────────────── By URL / number ──────────────── */

function ByUrlTab({
  issueId,
  kind,
  isAdmin,
  onLinked,
}: {
  issueId: string;
  kind: LinkKind;
  isAdmin: boolean;
  onLinked: () => void;
}) {
  const utils = trpc.useUtils();
  const [raw, setRaw] = useState("");
  const debounced = useDebounced(raw, 350);
  const parsed = useMemo(() => parseRef(debounced), [debounced]);
  const repoFullName = parsed?.repoFullName ?? null;

  const linkability = trpc.github.linkability.useQuery(
    { repoFullName: repoFullName ?? "" },
    // Only resolve once we have a concrete issue/PR number — every branch that
    // renders linkability output is gated on a number, and resolving a bare
    // repo would fire wasted GitHub installation probes.
    { enabled: !!repoFullName && parsed?.number != null, staleTime: 15_000, retry: false },
  );
  const ready =
    linkability.data?.status === "ready" ? linkability.data : null;

  const preview = trpc.github.preview.useQuery(
    parsed?.url
      ? { url: parsed.url, mappingId: ready?.mappingId }
      : { repoFullName: repoFullName ?? "", number: parsed?.number ?? 0, mappingId: ready?.mappingId },
    { enabled: !!ready && !!parsed?.number, staleTime: 15_000, retry: false },
  );

  const linkM = trpc.github.link.useMutation({
    onSuccess: () => {
      toast.success("GitHub resource linked.");
      void utils.github.listLinked.invalidate({ issueId });
      setRaw("");
      onLinked();
    },
    onError: (e) => toast.error(e.message),
  });

  // Always link the preview-resolved canonical url: a pasted `/issues/N` URL
  // where N is actually a PR resolves to its `/pull/N` form, so linking it
  // isn't rejected by the issue-URL-points-to-a-PR guard. Gating on the
  // resolved url (not the raw paste) also avoids a click-before-preview race.
  const linkUrl = preview.data?.url ?? null;
  const canLink = !!ready && !!linkUrl && !!parsed?.number;

  return (
    <div className="space-y-3">
      <Input
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        placeholder="https://github.com/org/repo/pull/123  ·  org/repo#123"
        className="h-9 font-mono text-xs"
        autoFocus
      />

      {/* Gate on `debounced` (not `raw`) so this transitions in lockstep with
          `parsed` instead of flashing during the debounce window. */}
      {debounced.trim() && !parsed && (
        <p className="text-meta text-muted-foreground">
          Enter a GitHub issue/PR URL, or <span className="font-mono">owner/repo#123</span>.
        </p>
      )}

      {parsed && !parsed.number && (
        <p className="text-meta text-muted-foreground">
          Add an issue/PR number — <span className="font-mono">{parsed.repoFullName}#123</span> —
          or use <span className="font-medium text-foreground">Browse a repo</span> to pick one.
        </p>
      )}

      {repoFullName && parsed?.number && linkability.isLoading && (
        <StatusLine icon={Loader2} spin>
          Checking access to <span className="font-mono">{repoFullName}</span>…
        </StatusLine>
      )}

      {linkability.isError && (
        <StatusLine icon={AlertCircle} tone="warning">
          {linkability.error.message}
        </StatusLine>
      )}

      {/* Ready → preview + link */}
      {ready && parsed?.number && (
        <div className="space-y-3">
          <ResourcePreview
            loading={preview.isLoading}
            error={preview.error?.message ?? null}
            snapshot={preview.data ?? null}
            fallbackRepo={repoFullName}
            fallbackNumber={parsed.number}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              variant="ember"
              size="sm"
              disabled={!canLink || linkM.isPending}
              onClick={() =>
                linkUrl && linkM.mutate({ issueId, url: linkUrl, kind, mappingId: ready.mappingId })
              }
            >
              {linkM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Link2 className="h-3.5 w-3.5" />}
              Link as {kindLabel(kind)}
            </Button>
          </div>
        </div>
      )}

      {/* Remediation states. Keyed by status+repo so the connection picker's
          local state resets when the user switches to a different repo/state. */}
      {linkability.data && linkability.data.status !== "ready" && parsed?.number != null && (
        <Remediation
          key={`${linkability.data.status}:${linkability.data.repoFullName}`}
          state={linkability.data}
          isAdmin={isAdmin}
          onResolved={() => void linkability.refetch()}
        />
      )}
    </div>
  );
}

/* ───────────────────────────────────── Remediation ──────────────────── */

type Linkability = inferRouterOutputs<AppRouter>["github"]["linkability"];

function Remediation({
  state,
  isAdmin,
  onResolved,
}: {
  state: Linkability;
  isAdmin: boolean;
  onResolved: () => void;
}) {
  const ws = useWorkspace();
  const connectionsHref = `/w/${ws.slug}/settings/connections`;
  const installHref = `/api/connections/github/install?returnTo=${encodeURIComponent(connectionsHref)}`;

  const mapM = trpc.github.mapRepo.useMutation({
    onSuccess: () => {
      toast.success("Repository connected.");
      onResolved();
    },
    onError: (e) => toast.error(e.message),
  });
  const resumeM = trpc.connectionMapping.update.useMutation({
    onSuccess: () => {
      toast.success("Mapping resumed.");
      onResolved();
    },
    onError: (e) => toast.error(e.message),
  });
  const connectAppM = trpc.github.connectApp.useMutation({
    onSuccess: () => {
      toast.success("GitHub App connected for linking.");
      onResolved();
    },
    onError: (e) => toast.error(e.message),
  });

  const [connectionId, setConnectionId] = useState<string>(
    state.status === "mappable" ? state.connections[0]?.connectionId ?? "" : "",
  );

  if (state.status === "app_available") {
    const app = state.apps[0];
    return (
      <RemediationCard
        tone="info"
        title="Use your GitHub App for linking"
        body={
          <>
            <span className="font-medium text-foreground">{app?.name ?? "Your GitHub App"}</span> is
            installed for this workspace. Connect it to link{" "}
            <span className="font-mono">{state.repoFullName}</span> — no reinstall needed.
          </>
        }
      >
        {isAdmin ? (
          <Button
            type="button"
            size="sm"
            variant="ember"
            disabled={connectAppM.isPending || !app}
            onClick={() =>
              app &&
              connectAppM.mutate({ githubAppId: app.githubAppId, repoFullName: state.repoFullName })
            }
          >
            {connectAppM.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <PlugZap className="h-3.5 w-3.5" />
            )}
            Use {app?.name ?? "GitHub App"}
          </Button>
        ) : (
          <AskAdmin>connect the workspace GitHub App for linking in Settings → Connections</AskAdmin>
        )}
      </RemediationCard>
    );
  }

  if (state.status === "paused") {
    return (
      <RemediationCard
        tone="warning"
        title="This repository's mapping is paused"
        body={
          <>
            <span className="font-mono">{state.repoFullName}</span> is connected but paused, so
            links are turned off.
          </>
        }
      >
        {isAdmin ? (
          <Button
            type="button"
            size="sm"
            variant="ember"
            disabled={resumeM.isPending}
            onClick={() => resumeM.mutate({ id: state.mappingId, status: "active" })}
          >
            {resumeM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Resume &amp; link
          </Button>
        ) : (
          <AskAdmin>resume the mapping in Settings → Connections</AskAdmin>
        )}
      </RemediationCard>
    );
  }

  if (state.status === "mappable") {
    return (
      <RemediationCard
        tone="info"
        title="Connect this repository"
        body={
          <>
            The GitHub App can reach <span className="font-mono">{state.repoFullName}</span>. Map it
            to start linking issues and PRs.
          </>
        }
      >
        {isAdmin ? (
          <div className="flex flex-wrap items-center gap-2">
            {state.connections.length > 1 && (
              <select
                value={connectionId}
                onChange={(e) => setConnectionId(e.target.value)}
                className="focus-ring h-8 rounded-md border border-input bg-background px-2 text-xs"
                aria-label="GitHub connection"
              >
                {state.connections.map((c) => (
                  <option key={c.connectionId} value={c.connectionId}>
                    {c.account ?? c.label}
                  </option>
                ))}
              </select>
            )}
            <Button
              type="button"
              size="sm"
              variant="ember"
              disabled={mapM.isPending || !connectionId}
              onClick={() => mapM.mutate({ connectionId, repoFullName: state.repoFullName })}
            >
              {mapM.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PlugZap className="h-3.5 w-3.5" />}
              Connect repository
            </Button>
          </div>
        ) : (
          <AskAdmin>connect this repository in Settings → Connections</AskAdmin>
        )}
      </RemediationCard>
    );
  }

  if (state.status === "needs_repo_access") {
    return (
      <RemediationCard
        tone="warning"
        title="The GitHub App can't see this repository"
        body={
          <>
            GitHub is connected
            {state.connections[0]?.account ? (
              <>
                {" "}
                for <span className="font-mono">{state.connections[0].account}</span>
              </>
            ) : null}
            , but the installation doesn&apos;t include{" "}
            <span className="font-mono">{state.repoFullName}</span>. Grant it access on GitHub, then
            retry.
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3">
          <a
            href="https://github.com/settings/installations"
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-foreground hover:underline"
          >
            Manage repository access on GitHub
            <ExternalLink className="h-3 w-3" />
          </a>
          {isAdmin && (
            <a
              href={connectionsHref}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              Connection settings
            </a>
          )}
        </div>
      </RemediationCard>
    );
  }

  // not_ready — non-admin: we deliberately don't probe, so just point at an admin.
  if (state.status === "not_ready") {
    return (
      <RemediationCard
        tone="info"
        title="This repository isn't connected yet"
        body={
          <>
            <span className="font-mono">{state.repoFullName}</span> isn&apos;t linked to this
            workspace.
          </>
        }
      >
        <AskAdmin>connect this repository in Settings → Connections</AskAdmin>
      </RemediationCard>
    );
  }

  // no_connection
  return (
    <RemediationCard
      tone="info"
      title="Connect GitHub to link issues and PRs"
      body="No GitHub App is connected to this workspace yet."
    >
      {isAdmin ? (
        <a
          href={installHref}
          className="focus-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-ember px-3 text-xs font-medium text-background hover:opacity-90"
        >
          <Github className="h-3.5 w-3.5" />
          Install the GitHub App
        </a>
      ) : (
        <AskAdmin>connect GitHub in Settings → Connections</AskAdmin>
      )}
    </RemediationCard>
  );
}

function AskAdmin({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-meta text-muted-foreground">
      Ask a workspace admin to {children}.
    </p>
  );
}

function RemediationCard({
  tone,
  title,
  body,
  children,
}: {
  tone: "info" | "warning";
  title: string;
  body: React.ReactNode;
  children: React.ReactNode;
}) {
  const Icon = tone === "warning" ? AlertCircle : PlugZap;
  return (
    <div
      className={
        "space-y-2 rounded-md border p-3 " +
        (tone === "warning" ? "border-warning/30 bg-warning/5" : "border-border bg-card/40")
      }
    >
      <div className="flex items-start gap-2">
        <Icon
          className={
            "mt-0.5 h-4 w-4 shrink-0 " + (tone === "warning" ? "text-warning" : "text-muted-foreground")
          }
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-[0.8125rem] font-medium text-foreground">{title}</p>
          <p className="text-meta leading-relaxed text-muted-foreground">{body}</p>
        </div>
      </div>
      <div className="pl-6">{children}</div>
    </div>
  );
}

/* ───────────────────────────────────── Browse ───────────────────────── */

function BrowseTab({
  issueId,
  kind,
  isAdmin,
  onLinked,
}: {
  issueId: string;
  kind: LinkKind;
  isAdmin: boolean;
  onLinked: () => void;
}) {
  const utils = trpc.useUtils();
  const ws = useWorkspace();
  const repos = trpc.github.browsableRepos.useQuery(undefined, { staleTime: 30_000 });
  const [selectedRepo, setSelectedRepo] = useState<string>("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"" | "issue" | "pr">("");
  const debouncedQuery = useDebounced(query, 350);
  const [linked, setLinked] = useState<Set<string>>(new Set());
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  // Repos we've already kicked an auto-map for — so the effect fires once per
  // repo and doesn't re-loop on a connect failure.
  const [autoConnected, setAutoConnected] = useState<Set<string>>(new Set());

  const current = repos.data?.find((r) => r.repoFullName === selectedRepo) ?? null;
  const mappingId = current?.mappingId ?? "";

  // Default the repo picker to the first repo (mapped repos sort first).
  useEffect(() => {
    if (!selectedRepo && repos.data && repos.data.length > 0) {
      setSelectedRepo(repos.data[0].repoFullName);
    }
  }, [repos.data, selectedRepo]);

  const connectRepoM = trpc.github.connectRepo.useMutation({
    onSuccess: () => void utils.github.browsableRepos.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  // Auto-map an unmapped repo the first time the admin searches it: picking a
  // repo the App can reach and typing "just works" — no separate connect step.
  // Once mapped, browsableRepos refetches and `mappingId` lights up the search.
  useEffect(() => {
    if (!current || current.mapped || !isAdmin) return;
    if (!debouncedQuery.trim()) return;
    if (autoConnected.has(current.repoFullName) || connectRepoM.isPending) return;
    setAutoConnected((prev) => new Set(prev).add(current.repoFullName));
    connectRepoM.mutate({ repoFullName: current.repoFullName });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.repoFullName, current?.mapped, debouncedQuery, isAdmin]);

  const connecting =
    !!current && !current.mapped && (connectRepoM.isPending || autoConnected.has(current.repoFullName));

  const search = trpc.github.search.useQuery(
    { mappingId, query: debouncedQuery, type: type || undefined },
    { enabled: !!mappingId && debouncedQuery.trim().length > 0, staleTime: 10_000, retry: false },
  );

  const linkM = trpc.github.link.useMutation({
    onSuccess: (_data, vars) => {
      toast.success("GitHub resource linked.");
      setLinked((prev) => new Set(prev).add(vars.url));
      void utils.github.listLinked.invalidate({ issueId });
      onLinked();
    },
    onError: (e) => toast.error(e.message),
    onSettled: () => setPendingUrl(null),
  });

  if (repos.isLoading) {
    return <StatusLine icon={Loader2} spin>Loading repositories…</StatusLine>;
  }
  if (!repos.data || repos.data.length === 0) {
    return (
      <RemediationCard
        tone="info"
        title="No repositories to browse yet"
        body="Connect the GitHub App to browse a repository's open issues and pull requests."
      >
        {isAdmin ? (
          <a
            href={`/api/connections/github/install?returnTo=${encodeURIComponent(`/w/${ws.slug}/settings/connections`)}`}
            className="focus-ring inline-flex h-8 items-center justify-center gap-1.5 rounded-md bg-ember px-3 text-xs font-medium text-background hover:opacity-90"
          >
            <Github className="h-3.5 w-3.5" />
            Install the GitHub App
          </a>
        ) : (
          <AskAdmin>connect a repository in Settings → Connections</AskAdmin>
        )}
      </RemediationCard>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={selectedRepo}
          onChange={(e) => setSelectedRepo(e.target.value)}
          className="focus-ring h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 font-mono text-xs"
          aria-label="Repository"
        >
          {repos.data.map((m) => (
            <option key={m.repoFullName} value={m.repoFullName}>
              {m.repoFullName}
              {m.mapped ? "" : " · not connected"}
            </option>
          ))}
        </select>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as "" | "issue" | "pr")}
          className="focus-ring h-8 rounded-md border border-input bg-background px-2 text-xs"
          aria-label="Type filter"
        >
          <option value="">All</option>
          <option value="issue">Issues</option>
          <option value="pr">PRs</option>
        </select>
      </div>

      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search open issues and PRs…"
          className="h-9 pl-7 text-xs"
          autoFocus
        />
      </div>

      {/* First-touch on an unmapped repo: surface the one-time connect step
          instead of a silent "no results". */}
      {connecting && debouncedQuery.trim() && (
        <StatusLine icon={Loader2} spin>
          Connecting <span className="font-mono">{current?.repoFullName}</span>…
        </StatusLine>
      )}
      {current && !current.mapped && !connecting && !debouncedQuery.trim() && (
        <p className="text-meta text-muted-foreground">
          Type to search — <span className="font-mono">{current.repoFullName}</span> connects
          automatically on first use.
        </p>
      )}

      {search.isLoading && debouncedQuery.trim() && (
        <StatusLine icon={Loader2} spin>Searching…</StatusLine>
      )}
      {search.isError && (
        <StatusLine icon={AlertCircle} tone="warning">{search.error.message}</StatusLine>
      )}
      {search.data && search.data.length === 0 && debouncedQuery.trim() && (
        <p className="text-meta text-muted-foreground">No matching open issues or PRs.</p>
      )}

      {search.data && search.data.length > 0 && (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto">
          {search.data.map((item) => {
            const isPr = !!item.pull_request;
            const url = item.html_url;
            const isLinked = linked.has(url);
            return (
              <li
                key={item.id}
                className="flex items-start gap-2 rounded-md border border-border bg-background/70 p-2"
              >
                {isPr ? (
                  <GitPullRequest className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <Github className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.8125rem] font-medium" title={item.title}>
                    {item.title}
                  </p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
                    <span className="font-mono">#{item.number}</span>
                    <span>{stateLabel(item.state)}</span>
                  </div>
                </div>
                {isLinked ? (
                  <span className="inline-flex items-center gap-1 px-2 text-meta text-success">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    linked
                  </span>
                ) : (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-7 shrink-0 px-2"
                    disabled={pendingUrl === url}
                    onClick={() => {
                      setPendingUrl(url);
                      linkM.mutate({ issueId, url, kind, mappingId });
                    }}
                  >
                    {pendingUrl === url ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <Link2 className="h-3 w-3" />
                    )}
                    Link
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ───────────────────────────────────── Shared bits ──────────────────── */

function ResourcePreview({
  loading,
  error,
  snapshot,
  fallbackRepo,
  fallbackNumber,
}: {
  loading: boolean;
  error: string | null;
  snapshot: { resourceType: string; title: string; state: string; url: string; repoFullName: string; number: number } | null;
  fallbackRepo: string | null;
  fallbackNumber: number;
}) {
  if (loading) {
    return <StatusLine icon={Loader2} spin>Loading {fallbackRepo}#{fallbackNumber}…</StatusLine>;
  }
  if (error) {
    return (
      <StatusLine icon={AlertCircle} tone="warning">
        {error}
      </StatusLine>
    );
  }
  if (!snapshot) return null;
  const isPr = snapshot.resourceType === "PULL_REQUEST";
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-background/70 p-2.5">
      {isPr ? (
        <GitPullRequest className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <Github className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <a
          href={snapshot.url}
          target="_blank"
          rel="noreferrer"
          className="block truncate text-[0.8125rem] font-medium hover:underline"
          title={snapshot.title}
        >
          {snapshot.title}
        </a>
        <div className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
          <span className="font-mono">
            {snapshot.repoFullName}#{snapshot.number}
          </span>
          <span>{stateLabel(snapshot.state)}</span>
        </div>
      </div>
    </div>
  );
}

function StatusLine({
  icon: Icon,
  spin,
  tone,
  children,
}: {
  icon: typeof Loader2;
  spin?: boolean;
  tone?: "warning";
  children: React.ReactNode;
}) {
  return (
    <p
      className={
        "flex items-center gap-1.5 text-meta " +
        (tone === "warning" ? "text-warning" : "text-muted-foreground")
      }
    >
      <Icon className={"h-3.5 w-3.5 shrink-0 " + (spin ? "animate-spin" : "")} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}
