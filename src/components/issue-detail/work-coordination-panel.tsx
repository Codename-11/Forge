"use client";

import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Combobox } from "@/components/ui/combobox";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

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

  const owner = latest?.ownerAgent
    ? `${latest.ownerAgent.name} · @${latest.ownerAgent.profileKey}`
    : (latest?.ownerUser?.name ?? latest?.ownerUser?.email ?? "Unassigned");
  const status = latest ? (STATUS_COPY[latest.status] ?? STATUS_COPY.CLAIMED) : null;

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
                <div className="truncate text-xs font-medium">{owner}</div>
                <div
                  className="mt-1 truncate font-mono text-[0.6875rem] text-muted-foreground"
                  title={latest.branch}
                >
                  {latest.repoFullName}:{latest.branch}
                </div>
                <div className="text-meta mt-1 text-muted-foreground">
                  {latest.source.toLowerCase().replaceAll("_", " ")} · base {latest.baseBranch} ·
                  seen {relativeTime(latest.lastHeartbeatAt)}
                </div>
                {latest.worktreePath && (
                  <div
                    className="mt-1 truncate font-mono text-[0.625rem] text-muted-foreground"
                    title={latest.worktreePath}
                  >
                    {latest.worktreePath}
                  </div>
                )}
              </div>
            </div>
          </div>

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
              source: "CODEX_DESKTOP",
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
