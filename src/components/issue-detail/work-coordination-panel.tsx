"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ChevronDown,
  GitBranch,
  CheckCircle2,
  CircleDot,
  GitPullRequest,
  PackageCheck,
  Play,
  Rocket,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { inferRouterOutputs } from "@trpc/server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { Tooltip } from "@/components/ui/tooltip";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { resolveDeliveryIdentity } from "@/lib/delivery-identity";
import { useWorkspace } from "@/hooks/use-workspace";
import type { AppRouter } from "@/server/routers/_app";

const TERMINAL = new Set(["VERIFIED", "ABANDONED"]);

const STATUS_COPY: Record<string, { label: string; tone: string }> = {
  CLAIMED: { label: "Claimed", tone: "text-muted-foreground" },
  IN_PROGRESS: { label: "In progress", tone: "text-ember" },
  PR_OPEN: { label: "PR open", tone: "text-ember" },
  IN_REVIEW: { label: "In review", tone: "text-warning" },
  READY_TO_MERGE: { label: "Ready to merge", tone: "text-success" },
  MERGED: { label: "Merged", tone: "text-success" },
  RELEASED: { label: "Released", tone: "text-success" },
  DEPLOYED: { label: "Deployed", tone: "text-success" },
  VERIFIED: { label: "Verified", tone: "text-success" },
  STALE: { label: "Stale", tone: "text-warning" },
  ABANDONED: { label: "Abandoned", tone: "text-muted-foreground" },
};

export function WorkCoordinationPanel({
  issueId,
  issueKey,
}: {
  issueId: string;
  issueKey: string;
}) {
  const workspace = useWorkspace();
  const canRelease = workspace.role === "OWNER" || workspace.role === "ADMIN";
  const utils = trpc.useUtils();
  const [creating, setCreating] = useState(false);
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState(`codex/${issueKey.toLowerCase()}-work`);
  const [baseBranch, setBaseBranch] = useState("main");
  const [worktreePath, setWorktreePath] = useState("");
  const [releaseVersion, setReleaseVersion] = useState("");

  const { data: sessions, isLoading } = trpc.workSession.listForIssue.useQuery(
    { issueId },
    { staleTime: 10_000, refetchOnWindowFocus: true },
  );
  const { data: mappings } = trpc.github.listMappings.useQuery({ includePaused: false });
  const { data: build } = trpc.system.buildInfo.useQuery();
  useEffect(() => {
    if (!repo && mappings?.[0]?.repoFullName) setRepo(mappings[0].repoFullName);
  }, [mappings, repo]);

  const active = useMemo(
    () => sessions?.find((session) => !TERMINAL.has(session.status)) ?? null,
    [sessions],
  );
  const latest = active ?? sessions?.[0] ?? null;
  const invalidate = () => {
    void utils.workSession.listForIssue.invalidate({ issueId });
    void utils.issue.byId.invalidate({ id: issueId });
  };
  const claim = trpc.workSession.claim.useMutation({
    onSuccess: () => {
      toast.success("Isolated work session claimed.");
      setCreating(false);
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const heartbeat = trpc.workSession.heartbeat.useMutation({
    onSuccess: () => {
      toast.success("Work session refreshed.");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const advance = trpc.workSession.advance.useMutation({
    onSuccess: () => invalidate(),
    onError: (error) => toast.error(error.message),
  });
  const reconcileOwnership = trpc.workSession.reconcileOwnership.useMutation({
    onSuccess: () => {
      toast.success("Delivery ownership reconciled.");
      invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const identity = latest ? resolveDeliveryIdentity(latest) : null;
  const status = latest ? (STATUS_COPY[latest.status] ?? STATUS_COPY.CLAIMED) : null;
  const provenance = latest ? deliveryProvenance(latest) : null;
  const connectionMismatch = Boolean(
    latest?.ownerConnection?.agent &&
    latest.ownerAgent &&
    latest.ownerConnection.agent.id !== latest.ownerAgent.id,
  );
  const observedMismatch = Boolean(
    latest?.observedImplementation?.agent &&
    latest.ownerAgent &&
    latest.observedImplementation.agent.id !== latest.ownerAgent.id,
  );
  const ownershipMismatch = connectionMismatch || observedMismatch;
  const observedConnection = latest?.observedImplementation?.run.connection ?? null;

  return (
    <section
      className="rounded-md border border-border bg-card/40"
      aria-label="Code work coordination"
    >
      <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
          Delivery
        </span>
        {status && (
          <span className={cn("ml-auto text-[0.6875rem] font-medium", status.tone)}>
            {status.label}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="text-meta p-2.5 text-muted-foreground">Checking ownership…</div>
      ) : latest ? (
        <div className="space-y-2.5 p-2.5">
          <div className="rounded-md border border-border bg-background/70 p-2.5">
            <div className="flex items-start gap-2">
              {latest.status === "STALE" ? (
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              ) : latest.status === "VERIFIED" ? (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
              ) : (
                <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ember" />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium">
                  {identity?.primaryLabel ?? "Unassigned"}
                </div>
                {identity?.summary && (
                  <div className="text-meta mt-0.5 truncate text-muted-foreground">
                    {identity.summary}
                  </div>
                )}
                {provenance && (
                  <div className="mt-1 flex flex-wrap items-center gap-1.5">
                    <span className="rounded border border-border/70 bg-subtle/60 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                      {provenance.invocationLabel}
                    </span>
                    {provenance.connectorLabel && (
                      <span className="rounded border border-border/70 bg-subtle/60 px-1.5 py-0.5 text-[0.5625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                        {provenance.connectorLabel}
                      </span>
                    )}
                    <Tooltip content={provenance.statusDescription}>
                      <span
                        tabIndex={0}
                        className={cn(
                          "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[0.625rem] font-medium",
                          provenance.badgeTone,
                        )}
                      >
                        {provenance.statusLabel}
                      </span>
                    </Tooltip>
                  </div>
                )}
                <div
                  className="mt-1 truncate font-mono text-[0.6875rem] text-muted-foreground"
                  title={latest.branch}
                >
                  {latest.repoFullName}:{latest.branch}
                </div>
                <details className="group mt-2 text-muted-foreground">
                  <summary className="focus-ring flex cursor-pointer list-none items-center justify-between rounded border border-border/70 bg-subtle/30 px-2 py-1 text-[0.6875rem] font-medium transition-colors hover:border-border hover:bg-subtle/70 hover:text-foreground group-open:border-border group-open:bg-subtle/60 [&::-webkit-details-marker]:hidden">
                    <span>Delivery evidence</span>
                    <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
                  </summary>
                  <dl className="mt-1.5 grid grid-cols-[5.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-[0.6875rem]">
                    <dt>Agent</dt>
                    <dd className="min-w-0 truncate text-foreground">
                      {identity?.agentLabel ?? "none recorded"}
                    </dd>
                    <dt>Operator</dt>
                    <dd className="min-w-0 truncate text-foreground">
                      {identity?.operatorLabel ?? "none recorded"}
                    </dd>
                    <dt>Invocation</dt>
                    <dd>{provenance?.invocationLabel ?? "unknown"}</dd>
                    <dt>Connector</dt>
                    <dd>{provenance?.connectorLabel ?? "none recorded"}</dd>
                    <dt>Runtime</dt>
                    <dd>{provenance?.runtimeLabel ?? "no dispatched run recorded"}</dd>
                    <dt>Base</dt>
                    <dd className="font-mono">{latest.baseBranch}</dd>
                    <dt>Activity</dt>
                    <dd>{relativeTime(latest.lastHeartbeatAt)}</dd>
                    {latest.worktreePath && (
                      <>
                        <dt>Worktree</dt>
                        <dd className="min-w-0 truncate font-mono" title={latest.worktreePath}>
                          {latest.worktreePath}
                        </dd>
                      </>
                    )}
                  </dl>
                </details>
              </div>
            </div>
          </div>

          {ownershipMismatch && (
            <div
              className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-2.5"
              role="status"
            >
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
              <div className="text-meta text-muted-foreground">
                <div className="font-medium text-foreground">Delivery attribution mismatch</div>
                The delivery owner is {latest.ownerAgent?.name ?? "unknown"}, but{" "}
                {connectionMismatch && latest.ownerConnection?.agent
                  ? `the registered connection belongs to ${latest.ownerConnection.agent.name}`
                  : `the latest observed implementation activity is from ${latest.observedImplementation?.agent.name ?? "another agent"}`}
                . Reconcile ownership before handoff or redispatch.
                {latest.observedImplementation && (
                  <span className="mt-1 block">
                    Evidence: {latest.observedImplementation.source.replaceAll("-", " ")} ·{" "}
                    {relativeTime(latest.observedImplementation.observedAt)}.
                  </span>
                )}
                {canRelease && observedConnection && observedMismatch && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7"
                    disabled={reconcileOwnership.isPending}
                    onClick={() =>
                      reconcileOwnership.mutate({
                        sessionId: latest.id,
                        targetConnectionId: observedConnection.id,
                      })
                    }
                  >
                    {reconcileOwnership.isPending
                      ? "Reconciling…"
                      : `Reconcile to ${latest.observedImplementation?.agent.name}`}
                  </Button>
                )}
              </div>
            </div>
          )}

          {provenance?.unconfirmedMcp && !ownershipMismatch && (
            <div className="flex items-start gap-2 rounded-md border border-warning/25 bg-warning/5 p-2.5">
              <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
              <div className="text-meta text-muted-foreground">
                <span className="font-medium text-foreground">MCP status is unconfirmed.</span>{" "}
                Recent access is known, but Forge cannot guarantee the client process lifecycle.
                Silence alone will not trigger automatic redispatch.
              </div>
            </div>
          )}

          {latest.participants.length > 1 && (
            <div className="rounded-md border border-border/70 bg-background/40 p-2.5">
              <div className="text-[0.625rem] font-semibold uppercase tracking-wider text-muted-foreground">
                Delivery participants
              </div>
              <ul className="mt-1.5 space-y-1">
                {latest.participants.map((participant) => (
                  <li key={participant.id} className="text-meta flex items-center gap-2">
                    <span className="w-20 shrink-0 uppercase text-muted-foreground">
                      {participant.role.toLowerCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      {participant.agent.name} via{" "}
                      {connectionKindLabel(participant.connection.kind, participant.connection)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {latest.pullRequest ? (
            <a
              href={latest.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="focus-ring flex items-center gap-2 rounded-md border border-border bg-background/50 px-2.5 py-2 text-xs hover:bg-subtle/60"
            >
              <GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">
                {latest.pullRequest.repoFullName}#{latest.pullRequest.number}
              </span>
              <span className="text-meta text-muted-foreground">{latest.pullRequest.state}</span>
            </a>
          ) : !TERMINAL.has(latest.status) ? (
            <div className="text-meta text-muted-foreground">
              Open a PR from this branch and link it as{" "}
              <span className="font-medium">implements</span>. Forge will match it automatically.
            </div>
          ) : null}

          {!TERMINAL.has(latest.status) && (
            <div className="flex flex-wrap gap-1.5">
              {(latest.status === "STALE" || latest.status === "CLAIMED") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => heartbeat.mutate({ sessionId: latest.id })}
                  disabled={heartbeat.isPending}
                >
                  <Play className="h-3 w-3" /> Resume
                </Button>
              )}
              {latest.status === "MERGED" && canRelease && (
                <div className="flex min-w-0 flex-1 gap-1.5">
                  <Input
                    value={releaseVersion}
                    onChange={(e) => setReleaseVersion(e.target.value)}
                    placeholder="v0.20.0"
                    className="h-8 min-w-0"
                  />
                  <Button
                    size="sm"
                    onClick={() =>
                      advance.mutate({
                        sessionId: latest.id,
                        status: "RELEASED",
                        releasedVersion: releaseVersion || null,
                      })
                    }
                    disabled={advance.isPending || !releaseVersion.trim()}
                  >
                    <PackageCheck className="h-3 w-3" /> Release
                  </Button>
                </div>
              )}
              {latest.status === "RELEASED" && canRelease && (
                <Button
                  size="sm"
                  onClick={() =>
                    advance.mutate({
                      sessionId: latest.id,
                      status: "DEPLOYED",
                      deployedSha: build?.gitSha ?? null,
                    })
                  }
                  disabled={advance.isPending || !build?.gitSha}
                  title={
                    build?.gitSha
                      ? `Confirm that build ${build.gitSha} is deployed`
                      : "The running build must report its exact commit SHA"
                  }
                >
                  <Rocket className="h-3 w-3" /> Confirm deployed
                </Button>
              )}
              {latest.status === "DEPLOYED" && canRelease && (
                <Button
                  size="sm"
                  onClick={() => advance.mutate({ sessionId: latest.id, status: "VERIFIED" })}
                  disabled={advance.isPending}
                >
                  <CheckCircle2 className="h-3 w-3" /> Verify live
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-muted-foreground"
                onClick={() => advance.mutate({ sessionId: latest.id, status: "ABANDONED" })}
                disabled={advance.isPending}
              >
                <X className="h-3 w-3" /> Abandon
              </Button>
              {!canRelease && ["MERGED", "RELEASED", "DEPLOYED"].includes(latest.status) && (
                <span className="text-meta text-muted-foreground">
                  Waiting for workspace admin approval
                </span>
              )}
            </div>
          )}
        </div>
      ) : creating ? (
        <form
          className="space-y-2.5 p-2.5"
          onSubmit={(event) => {
            event.preventDefault();
            claim.mutate({
              issueId,
              repoFullName: repo,
              branch,
              baseBranch,
              worktreePath: worktreePath || null,
            });
          }}
        >
          <label className="text-meta block space-y-1 text-muted-foreground">
            <span>Repository</span>
            {mappings?.length ? (
              <Combobox
                ariaLabel="Repository"
                value={repo || null}
                onChange={(value) => setRepo(value ?? "")}
                options={mappings.map((mapping) => ({
                  value: mapping.repoFullName,
                  label: mapping.repoFullName,
                }))}
                placeholder="Choose a repository"
              />
            ) : (
              <Input
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="owner/repository"
                className="h-8"
              />
            )}
          </label>
          <label className="text-meta block space-y-1 text-muted-foreground">
            <span>Branch</span>
            <Input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              className="h-8 font-mono"
            />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="text-meta block space-y-1 text-muted-foreground">
              <span>Base</span>
              <Input
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                className="h-8 font-mono"
              />
            </label>
            <label className="text-meta block space-y-1 text-muted-foreground">
              <span>Worktree path (optional)</span>
              <Input
                value={worktreePath}
                onChange={(e) => setWorktreePath(e.target.value)}
                className="h-8 font-mono"
              />
            </label>
          </div>
          <div className="flex justify-end gap-1.5">
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={!repo || !branch || claim.isPending}>
              Claim work
            </Button>
          </div>
        </form>
      ) : (
        <div className="p-2.5">
          <p className="text-meta text-muted-foreground">
            Claim an isolated branch before editing so Forge agents, Desktop tasks, and contributors
            share one owner.
          </p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setCreating(true)}>
            <GitBranch className="h-3 w-3" /> Start isolated work
          </Button>
        </div>
      )}
    </section>
  );
}

type DeliverySession = inferRouterOutputs<AppRouter>["workSession"]["listForIssue"][number];

function connectionKindLabel(
  kind: NonNullable<DeliverySession["ownerConnection"]>["kind"],
  connection: {
    displayName?: string | null;
    clientName?: string | null;
    runtime?: { name: string } | null;
  },
) {
  const kindLabel =
    kind === "MCP_CLIENT"
      ? "MCP"
      : kind === "MANAGED_RUNTIME"
        ? "Runtime"
        : kind === "WEBHOOK"
          ? "Webhook"
          : "On-demand";
  const name = connection.displayName ?? connection.clientName ?? connection.runtime?.name;
  return name ? `${kindLabel} · ${name}` : kindLabel;
}

function deliveryProvenance(session: DeliverySession): {
  invocationLabel: string;
  connectorLabel: string | null;
  runtimeLabel: string | null;
  statusLabel: string;
  statusDescription: string;
  badgeTone: string;
  unconfirmedMcp: boolean;
} {
  const connection = session.ownerConnection;
  const invocationLabel =
    session.source === "MCP"
      ? "Forge MCP"
      : session.source === "NATIVE_SESSION"
        ? "Native session"
        : session.source === "ISSUE_DISPATCH"
          ? "Issue dispatch"
          : session.source === "SCHEDULED"
            ? "Scheduled"
            : session.source === "MANUAL"
              ? "Manual UI"
              : session.source === "CONTRIBUTOR"
                ? "Contributor"
                : session.source === "CODEX_DESKTOP"
                  ? "Legacy desktop claim"
                  : "Legacy Forge agent";
  const run = session.observedImplementation?.run;
  const runtimeLabel =
    run?.externalRunId && run.connection?.kind === "MANAGED_RUNTIME" && run.connection.runtime
      ? `${run.connection.runtime.name}${run.runEngine ? ` · ${run.runEngine.toLowerCase()}` : ""}`
      : null;
  if (!connection) {
    return {
      invocationLabel,
      connectorLabel: null,
      runtimeLabel,
      statusLabel: "provenance not registered",
      statusDescription:
        "No concrete client or runtime connection is attached to this delivery session.",
      badgeTone: "border-border bg-subtle/60 text-muted-foreground",
      unconfirmedMcp: session.source === "MCP",
    };
  }
  const unconfirmedMcp = connection.kind === "MCP_CLIENT" && connection.confidence !== "CONFIRMED";
  const statusLabel =
    connection.status === "ACTIVE"
      ? connection.confidence === "CONFIRMED"
        ? "confirmed active"
        : "activity inferred"
      : connection.status === "QUIET" && unconfirmedMcp
        ? "quiet · status unconfirmed"
        : connection.status.toLowerCase();
  const badgeTone =
    connection.status === "DISCONNECTED" || connection.status === "REVOKED"
      ? "border-danger/30 bg-danger/10 text-danger"
      : connection.status === "QUIET"
        ? "border-warning/30 bg-warning/10 text-warning"
        : connection.status === "ACTIVE" && connection.confidence === "CONFIRMED"
          ? "border-success/30 bg-success/10 text-success"
          : "border-border bg-subtle/60 text-muted-foreground";
  const statusDescription =
    connection.status === "ACTIVE" && connection.confidence === "CONFIRMED"
      ? "Forge has direct, current evidence that this delivery connection is active."
      : connection.status === "ACTIVE"
        ? "Recent activity was observed, but live connection presence is not fully confirmed."
        : connection.status === "QUIET" && unconfirmedMcp
          ? "The MCP client has not sent a recent signal. Silence does not prove that it is offline."
          : connection.status === "QUIET"
            ? "This connection has not produced a recent activity signal."
            : connection.status === "DISCONNECTED"
              ? "The client or runtime explicitly disconnected from Forge."
              : connection.status === "REVOKED"
                ? "This delivery connection was revoked and can no longer act."
                : "Forge has recorded this connection state from the latest available evidence.";
  return {
    invocationLabel,
    connectorLabel: connectionKindLabel(connection.kind, connection),
    runtimeLabel,
    statusLabel,
    statusDescription,
    badgeTone,
    unconfirmedMcp,
  };
}
