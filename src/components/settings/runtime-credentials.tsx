"use client";
import { useState } from "react";
import { toast } from "sonner";
import { KeyRound, GitBranch, Trash2, Plus } from "lucide-react";
import { Section } from "@/components/ui";
import { Card } from "@/components/settings/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Confirm } from "@/components/ui/modal";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";

/**
 * Runtime credentials: encrypted secrets injected into the runtime at provision
 * time (gh/git tokens, deploy creds) and the repos it clone-or-pulls into its
 * workspace. Secret values are write-only — the API never returns them, so the
 * list shows only the key + description. The runtime reads its own decrypted
 * values via the `runtimes.provisioning` MCP tool.
 */
export function RuntimeCredentials({ runtimeId }: { runtimeId: string }) {
  return (
    <>
      <SecretsSection runtimeId={runtimeId} />
      <ReposSection runtimeId={runtimeId} />
    </>
  );
}

function SecretsSection({ runtimeId }: { runtimeId: string }) {
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
            No secrets yet. Add a <span className="font-mono">GH_TOKEN</span> to give this
            runtime git/gh access.
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
