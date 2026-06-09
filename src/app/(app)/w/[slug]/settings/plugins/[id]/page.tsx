"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { notFound, useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Check,
  ChevronLeft,
  Download,
  KeyRound,
  Plug,
  Plus,
  Puzzle,
  Radio,
  Webhook,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Confirm } from "@/components/ui/modal";
import { Card } from "@/components/settings/card";
import { Section, SkeletonList } from "@/components/ui";
import { useWorkspace } from "@/hooks/use-workspace";
import { trpc } from "@/lib/trpc";
import { relativeTime } from "@/lib/utils";
import { PLUGIN_SCOPE_HELP } from "@/lib/plugin-scopes";

const statusTone: Record<string, string> = {
  APPROVED: "#65a30d",
  PENDING: "#ca8a04",
  SUSPENDED: "#d97706",
  REVOKED: "#be185d",
};

type TabId = "overview" | "permissions" | "configuration" | "activity";
const TABS: { id: TabId; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "permissions", label: "Permissions" },
  { id: "configuration", label: "Configuration" },
  { id: "activity", label: "Activity" },
];

/**
 * Generic, manifest-driven plugin detail. Renders whatever scopes,
 * skills, events, and webhooks the registered plugin actually declares —
 * no plugin is special-cased. The identity header pulls publisher +
 * description from `manifest.author` / `manifest.description`; the
 * Approved-scopes rows map each `PluginScope` through the shared
 * `PLUGIN_SCOPE_HELP` blurbs (same copy as the list page's reference
 * grid). Activity is honest: it lists each webhook's subscribed events
 * rather than fabricating delivery rows we don't have loaded.
 */
export default function PluginDetailPage() {
  const ws = useWorkspace();
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const utils = trpc.useUtils();

  const { data: plugin, isLoading } = trpc.plugin.byId.useQuery(
    { id },
    { enabled: !!id },
  );

  const [removeOpen, setRemoveOpen] = useState(false);
  const [tab, setTab] = useState<TabId>("overview");
  const [backupPending, setBackupPending] = useState(false);

  // 1 / 2 / 3 / 4 switch tabs — mirrors the issue-detail rail pattern.
  // Bail out while typing or with modifier keys held.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable
      )
        return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const idx = ["1", "2", "3", "4"].indexOf(e.key);
      if (idx >= 0) {
        e.preventDefault();
        setTab(TABS[idx].id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const approve = trpc.plugin.approve.useMutation({
    onSuccess: () => {
      toast.success("Plugin approved.");
      void utils.plugin.byId.invalidate({ id });
      void utils.plugin.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const suspend = trpc.plugin.suspend.useMutation({
    onSuccess: () => {
      toast.success("Plugin suspended.");
      void utils.plugin.byId.invalidate({ id });
      void utils.plugin.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const rotateSecret = trpc.plugin.rotateSecret.useMutation({
    onSuccess: () => toast.success("Signing secret rotated."),
    onError: (e) => toast.error(e.message),
  });

  const remove = trpc.plugin.remove.useMutation({
    onSuccess: () => {
      toast.success("Plugin removed.");
      void utils.plugin.list.invalidate();
      setRemoveOpen(false);
      router.push(`/w/${ws.slug}/settings/plugins`);
    },
    onError: (e) => toast.error(e.message),
  });

  const downloadBackup = async () => {
    if (!plugin || backupPending) return;
    setBackupPending(true);
    try {
      const backup = await utils.plugin.exportBackup.fetch({ id });
      const blob = new Blob([JSON.stringify(backup, null, 2)], {
        type: "application/json;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `forge-plugin-${plugin.slug}-backup.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Plugin backup downloaded.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not export plugin backup.");
    } finally {
      setBackupPending(false);
    }
  };

  if (!isLoading && !plugin) notFound();

  // Manifest is opaque JSON on the model — narrow the few fields we read.
  const manifest = (plugin?.manifest ?? {}) as {
    author?: { name?: string; url?: string };
    description?: string;
    events?: string[];
  };
  const publisher = manifest.author?.name ?? "unknown publisher";
  const events = manifest.events ?? [];
  const description = plugin?.description ?? manifest.description ?? null;

  return (
    <>
      <Topbar
        title={
          <span className="flex items-center gap-2">
            <Link
              href={`/w/${ws.slug}/settings/plugins`}
              className="text-muted-foreground hover:text-foreground"
              title="Back to Plugins"
            >
              <ChevronLeft className="h-4 w-4" />
            </Link>
            <Puzzle className="h-4 w-4 text-muted-foreground" />
            <span>{plugin?.name ?? "Plugin"}</span>
            {plugin && (
              <Badge color={statusTone[plugin.status]}>{plugin.status}</Badge>
            )}
          </span>
        }
        subtitle={
          plugin
            ? `v${plugin.version} · by ${publisher}${
                description ? ` · ${description}` : ""
              }`
            : undefined
        }
        actions={
          plugin && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={downloadBackup}
                disabled={backupPending}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                Backup
              </Button>
              {plugin.status === "PENDING" && (
                <Button
                  size="sm"
                  variant="ember"
                  onClick={() => approve.mutate({ id })}
                  disabled={approve.isPending}
                >
                  Approve
                </Button>
              )}
              {plugin.status === "SUSPENDED" && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => approve.mutate({ id })}
                  disabled={approve.isPending}
                >
                  Re-enable
                </Button>
              )}
              {plugin.status === "APPROVED" && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => suspend.mutate({ id })}
                  disabled={suspend.isPending}
                >
                  Suspend
                </Button>
              )}
            </>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6">
          {!plugin ? (
            <SkeletonList rows={5} />
          ) : (
            <>
              {plugin.status === "PENDING" && (
                <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/[0.04] p-3 text-meta">
                  <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-foreground">
                        This plugin is awaiting review.
                      </span>
                      <Badge color={statusTone.PENDING}>review</Badge>
                    </div>
                    <div className="mt-0.5 text-muted-foreground">
                      It requests{" "}
                      {plugin.scopes.map((s, i) => (
                        <span key={s}>
                          {i > 0 && ", "}
                          <span className="font-mono text-foreground">{s}</span>
                        </span>
                      ))}
                      . Review the scopes below before approving.
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ember"
                    onClick={() => approve.mutate({ id })}
                    disabled={approve.isPending}
                  >
                    Approve
                  </Button>
                </div>
              )}

              {/* Identity card */}
              <Card as="div" className="divide-y-0 p-4">
                <div className="flex flex-wrap items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border bg-subtle/50 text-foreground/80">
                    <Puzzle className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-sm font-semibold">{plugin.name}</h2>
                      <Badge color={statusTone[plugin.status]}>
                        {plugin.status}
                      </Badge>
                      <span className="rounded-md border border-border bg-card/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                        v{plugin.version}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-3 text-meta text-muted-foreground">
                      <span className="font-mono">
                        slug <span className="text-id">{plugin.slug}</span>
                      </span>
                      <span>·</span>
                      <span>by {publisher}</span>
                      <span>·</span>
                      <span>registered {relativeTime(plugin.createdAt)} ago</span>
                    </div>
                  </div>
                </div>
              </Card>

              {/* Tab strip — underline-active, ember underline. Mirrors the
                  issue-detail rail. Keys 1/2/3/4 switch tabs. Manifest updates
                  now move the registration back to PENDING when review is
                  required, so this detail page uses the normal pending review
                  banner instead of a separate upgrade model. */}
              <div
                role="tablist"
                aria-label="Plugin detail sections"
                className="flex items-center gap-1 border-b border-border text-xs"
              >
                {TABS.map((t) => {
                  const selected = tab === t.id;
                  const count =
                    t.id === "permissions"
                      ? plugin.scopes.length
                      : t.id === "activity"
                        ? plugin.webhooks.length
                        : undefined;
                  return (
                    <button
                      key={t.id}
                      role="tab"
                      type="button"
                      aria-selected={selected}
                      onClick={() => setTab(t.id)}
                      title={`${t.label} — ${TABS.indexOf(t) + 1}`}
                      className={cn(
                        "focus-ring relative h-8 px-3",
                        selected
                          ? "text-foreground"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t.label}
                      {typeof count === "number" && (
                        <span className="ml-1 text-meta tabular-nums">
                          {count}
                        </span>
                      )}
                      {selected && (
                        <span
                          aria-hidden
                          className="absolute inset-x-2 -bottom-px h-0.5 bg-ember"
                        />
                      )}
                    </button>
                  );
                })}
              </div>

              {/* ───────────────────────── Overview ───────────────────────── */}
              {tab === "overview" && (
                <>
              {/* What this plugin does */}
              <Section
                title="What this plugin does"
                hint="Pulled from the plugin manifest."
              >
                <Card as="div" className="divide-y-0 p-5 text-sm leading-relaxed text-foreground/90">
                  {description ? (
                    <p>{description}</p>
                  ) : (
                    <p className="text-muted-foreground">
                      The manifest didn&apos;t include a description.
                    </p>
                  )}
                </Card>
              </Section>

              {/* Subscribed events */}
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Radio className="h-3.5 w-3.5 text-muted-foreground" />
                    Subscribed events
                    <span className="font-mono text-meta text-muted-foreground">
                      {events.length}
                    </span>
                  </span>
                }
                hint="Event kinds the manifest asks to receive."
              >
                <Card as="div" className="divide-y-0 p-4">
                  {events.length === 0 ? (
                    <div className="text-meta text-muted-foreground">
                      This plugin doesn&apos;t subscribe to any events.
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {events.map((e) => (
                        <span
                          key={e}
                          className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                        >
                          {e}
                        </span>
                      ))}
                    </div>
                  )}
                </Card>
              </Section>

              {/* Skills */}
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Zap className="h-3.5 w-3.5 text-muted-foreground" />
                    Skills
                    <span className="font-mono text-meta text-muted-foreground">
                      {plugin.skills.length}
                    </span>
                  </span>
                }
                hint="Invocable tools this plugin registers."
              >
                <Card as="div" className="divide-y-0 p-0">
                  {plugin.skills.length === 0 ? (
                    <div className="px-4 py-6 text-meta text-muted-foreground">
                      No skills registered.
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {plugin.skills.map((s) => (
                        <li key={s.id} className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-id text-foreground">
                              {s.name}
                            </span>
                            <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                              {s.runtime}
                            </span>
                          </div>
                          {s.description && (
                            <div className="mt-0.5 text-meta text-muted-foreground">
                              {s.description}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </Section>

              {/* API keys */}
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <KeyRound className="h-3.5 w-3.5 text-muted-foreground" />
                    API keys
                    <span className="font-mono text-meta text-muted-foreground">
                      {plugin.apiKeys.length}
                    </span>
                  </span>
                }
                hint="Active keys issued to this plugin (revoked keys hidden)."
              >
                <Card as="div" className="divide-y-0 p-0">
                  {plugin.apiKeys.length === 0 ? (
                    <div className="px-4 py-6 text-meta text-muted-foreground">
                      No active API keys.
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {plugin.apiKeys.map((k) => (
                        <li key={k.id} className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {k.name}
                            </span>
                            <span className="text-id text-muted-foreground">
                              {k.prefix}…
                            </span>
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-meta text-muted-foreground">
                            <span>
                              {k.lastUsedAt
                                ? `last used ${relativeTime(k.lastUsedAt)} ago`
                                : "never used"}
                            </span>
                            {k.expiresAt && (
                              <>
                                <span>·</span>
                                <span>
                                  expires {relativeTime(k.expiresAt)}
                                </span>
                              </>
                            )}
                            {k.scopes.length > 0 && (
                              <>
                                <span>·</span>
                                <span className="font-mono">
                                  {k.scopes.join(" ")}
                                </span>
                              </>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </Section>

                </>
              )}

              {/* ──────────────────────── Permissions ──────────────────────── */}
              {tab === "permissions" && (
                <Section
                  title="Approved scopes"
                  hint="What the plugin can read or write. Tighter is safer — approve the smallest set that does the job."
                >
                  <Card as="div" className="divide-y-0 p-0">
                    {plugin.scopes.length === 0 ? (
                      <div className="px-4 py-6 text-meta text-muted-foreground">
                        No scopes declared.
                      </div>
                    ) : (
                      <ul className="divide-y divide-border/60">
                        {plugin.scopes.map((scope) => (
                          <li
                            key={scope}
                            className="flex items-center gap-3 px-4 py-2.5"
                          >
                            <Check className="h-3 w-3 shrink-0 text-success" />
                            <span className="text-id text-foreground">
                              {scope}
                            </span>
                            <span className="text-meta text-muted-foreground">
                              {PLUGIN_SCOPE_HELP[scope] ?? "Scoped access."}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </Section>
              )}

              {/* ─────────────────────── Configuration ─────────────────────── */}
              {tab === "configuration" && (
                <>
              {/* Webhook configuration — honest about what config exists. The
                  manifest carries no free-form config block today, so we show
                  the signing-secret rotation + webhook endpoints here, plus a
                  legacy webhook-url note when present. */}
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                    Webhook delivery
                    <span className="font-mono text-meta text-muted-foreground">
                      {plugin.webhooks.length}
                    </span>
                  </span>
                }
                hint="Outbound endpoints the plugin is configured to receive on. The signing secret is rotated from the danger zone below."
              >
                <Card as="div" className="divide-y-0 p-0">
                  {plugin.webhooks.length === 0 ? (
                    <div className="px-4 py-6 text-meta text-muted-foreground">
                      No webhooks configured.
                      {plugin.webhookUrl && (
                        <>
                          {" "}
                          Legacy webhook URL on the plugin row:{" "}
                          <span className="font-mono text-foreground/80">
                            {plugin.webhookUrl}
                          </span>
                          .
                        </>
                      )}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {plugin.webhooks.map((w) => (
                        <li key={w.id} className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-id text-foreground">
                              {w.url}
                            </span>
                            <span
                              className={
                                w.active
                                  ? "rounded-md bg-success/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-success"
                                  : "rounded-md bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                              }
                            >
                              {w.active ? "active" : "paused"}
                            </span>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </Section>

              {/* Danger zone — destructive config lives here, matching the
                  design's danger zone placement. */}
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Plug className="h-3.5 w-3.5 text-danger" />
                    Danger zone
                  </span>
                }
              >
                <Card as="div" className="divide-y divide-border/60 p-0">
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        Rotate signing secret
                      </div>
                      <div className="mt-0.5 text-meta text-muted-foreground">
                        Issues a fresh HMAC secret for webhook signing. The
                        plugin must re-read it out of band; old signatures
                        stop validating.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => rotateSecret.mutate({ id })}
                      disabled={rotateSecret.isPending}
                    >
                      Rotate secret
                    </Button>
                  </div>
                  {plugin.status === "APPROVED" && (
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">
                          Suspend plugin
                        </div>
                        <div className="mt-0.5 text-meta text-muted-foreground">
                          Keeps its config but stops receiving deliveries.
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => suspend.mutate({ id })}
                        disabled={suspend.isPending}
                      >
                        Suspend
                      </Button>
                    </div>
                  )}
                  <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-foreground">
                        Remove plugin
                      </div>
                      <div className="mt-0.5 text-meta text-muted-foreground">
                        Deletes the registration, its skills, API keys, and
                        webhooks. Download a backup first if this plugin may
                        need to be restored. Linked issues stay; sync stops
                        immediately.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => setRemoveOpen(true)}
                    >
                      Remove
                    </Button>
                  </div>
                </Card>
              </Section>
                </>
              )}

              {/* ───────────────────────── Activity ───────────────────────── */}
              {tab === "activity" && (
              /* Honest: per-webhook subscriptions, not fabricated delivery
                 rows (deliveries aren't loaded here). */
              <Section
                title={
                  <span className="flex items-center gap-2">
                    <Webhook className="h-3.5 w-3.5 text-muted-foreground" />
                    Webhooks &amp; activity
                    <span className="font-mono text-meta text-muted-foreground">
                      {plugin.webhooks.length}
                    </span>
                  </span>
                }
                hint="Outbound endpoints and the events each one receives. Delivery history isn't loaded on this page."
              >
                <Card as="div" className="divide-y-0 p-0">
                  {plugin.webhooks.length === 0 ? (
                    <div className="px-4 py-6 text-meta text-muted-foreground">
                      No webhooks configured.
                      {plugin.webhookUrl && (
                        <>
                          {" "}
                          Legacy webhook URL on the plugin row:{" "}
                          <span className="font-mono text-foreground/80">
                            {plugin.webhookUrl}
                          </span>
                          .
                        </>
                      )}
                    </div>
                  ) : (
                    <ul className="divide-y divide-border/60">
                      {plugin.webhooks.map((w) => (
                        <li key={w.id} className="px-4 py-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-id text-foreground">
                              {w.url}
                            </span>
                            <span
                              className={
                                w.active
                                  ? "rounded-md bg-success/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-success"
                                  : "rounded-md bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                              }
                            >
                              {w.active ? "active" : "paused"}
                            </span>
                          </div>
                          {w.events.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1.5">
                              {w.events.map((e) => (
                                <span
                                  key={e}
                                  className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground"
                                >
                                  {e}
                                </span>
                              ))}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </Section>
              )}
            </>
          )}
        </div>
      </div>

      <Confirm
        open={removeOpen}
        onOpenChange={(v) => !v && setRemoveOpen(false)}
        title={`Remove ${plugin?.name ?? "plugin"}?`}
        description="This deletes the registration along with its skills, API keys, and webhooks. Linked issues are untouched. Download a backup first if this may need to be restored."
        primaryLabel="Remove plugin"
        variant="destructive"
        typeToConfirm="REMOVE"
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ id })}
      />
    </>
  );
}
