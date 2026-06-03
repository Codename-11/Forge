"use client";
import { useState } from "react";
import { Activity, ScrollText, Webhook } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { AgentAvatar } from "@/components/agents/agent-avatar";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/settings/section";
import { trpc } from "@/lib/trpc";
import { cn, initials, relativeTime } from "@/lib/utils";

type Tab = "audit" | "events" | "deliveries";

const deliveryTone: Record<string, string> = {
  PENDING: "#ca8a04",
  SUCCESS: "#65a30d",
  FAILED: "#be185d",
  DEAD_LETTER: "#7c2d12",
};

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("audit");
  const { data: stats, error: statsErr } = trpc.admin.stats.useQuery();

  if (statsErr) {
    return (
      <>
        <Topbar title="Admin" />
        <div className="mx-auto max-w-5xl p-4 text-sm text-muted-foreground sm:p-6">
          {statsErr.message.includes("Admin")
            ? "Admin role required to view this page."
            : statsErr.message}
        </div>
      </>
    );
  }

  const cards = [
    { label: "Members", value: stats?.users, hint: "workspace membership rows" },
    { label: "Open issues", value: stats?.openIssues, hint: `${stats?.issues ?? 0} total` },
    { label: "Projects", value: stats?.projects, hint: "active" },
    { label: "Plugins", value: stats?.plugins, hint: `${stats?.approvedPlugins ?? 0} approved` },
    { label: "API keys", value: stats?.activeApiKeys, hint: `${stats?.apiKeys ?? 0} total` },
    {
      label: "Events (24h)",
      value: stats?.recentEvents,
      hint: "activity events",
    },
    {
      label: "Webhook fails (7d)",
      value: stats?.webhookFailures,
      hint: "delivery failures",
      danger: (stats?.webhookFailures ?? 0) > 0,
    },
  ];

  const tabs: { id: Tab; label: string }[] = [
    { id: "audit", label: "Audit log" },
    { id: "events", label: "Activity events" },
    { id: "deliveries", label: "Webhook deliveries" },
  ];

  return (
    <>
      <Topbar
        title="Admin"
        subtitle="Workspace-wide observability. Audit, events, webhook delivery."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
          <Section
            title="Overview"
            hint="Workspace-wide health at a glance. Counts update as activity flows through the workspace."
          >
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-4">
              {cards.map((c) => (
                <div
                  key={c.label}
                  className={cn(
                    "rounded-lg border bg-card/40 p-3",
                    c.danger ? "border-danger/40" : "border-border",
                  )}
                >
                  <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                    {c.label}
                  </div>
                  <div
                    className={cn(
                      "mt-1 font-mono text-2xl tabular-nums",
                      c.danger && "text-danger",
                    )}
                  >
                    {c.value ?? "—"}
                  </div>
                  <div className="mt-1 text-[0.6875rem] text-muted-foreground">{c.hint}</div>
                </div>
              ))}
            </div>
          </Section>

          <Section
            title="Activity"
            hint="Audit log, raw activity events, and outbound webhook delivery health. Switch streams below."
          >
            <div className="space-y-2">
              <div className="flex gap-1 rounded-md bg-subtle p-0.5 text-[0.6875rem]">
                {tabs.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTab(t.id)}
                    className={cn(
                      "focus-ring flex-1 rounded px-2 py-1 transition-colors",
                      tab === t.id
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {tab === "audit" && <AuditTab />}
              {tab === "events" && <EventsTab />}
              {tab === "deliveries" && <DeliveriesTab />}
            </div>
          </Section>
        </div>
      </div>
    </>
  );
}

function AuditTab() {
  const { data, isLoading } = trpc.admin.audit.useQuery({ limit: 100 });
  if (isLoading)
    return (
      <Card>
        <li className="px-4 py-3 text-xs text-muted-foreground">Loading…</li>
      </Card>
    );
  const items = data?.items ?? [];
  if (items.length === 0)
    return (
      <Card>
        <EmptyState
          icon={ScrollText}
          title="No audit rows yet"
          hint="Mutations like status changes, label edits, and agent dispatch land here with the actor and a timestamp as they happen."
        />
      </Card>
    );
  return (
    <Card>
      {items.map((a) => (
        <li key={a.id} className="flex items-start gap-3 px-4 py-3 text-xs">
          {a.actorAgent ? (
            // Agent is the recorded actor; the human key-owner is secondary
            // (surfaced in the line below + tooltip).
            <AgentAvatar
              agent={{
                name: a.actorAgent.name,
                profileKey: a.actorAgent.profileKey,
                avatar: a.actorAgent.avatar,
              }}
              size="sm"
            />
          ) : (
            <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-subtle text-[0.6875rem] font-medium">
              {initials(a.actor?.name ?? a.actor?.email ?? null)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Badge>{a.action}</Badge>
              {a.actorAgent && (
                <Badge
                  color="#6366f1"
                  className="font-mono text-[0.6875rem] uppercase tracking-wider"
                >
                  agent
                </Badge>
              )}
              <span className="font-mono text-[0.6875rem] text-muted-foreground">
                {a.entity}/{a.entityId.slice(0, 8)}
              </span>
              <span className="ml-auto text-[0.6875rem] text-muted-foreground">
                {relativeTime(a.createdAt)}
              </span>
            </div>
            {(a.actorAgent || a.actor || a.ip) && (
              <div
                className="mt-0.5 text-[0.6875rem] text-muted-foreground"
                title={
                  a.actorAgent && a.actor?.name
                    ? `via API key owned by ${a.actor.name}`
                    : undefined
                }
              >
                {a.actorAgent
                  ? a.actorAgent.name
                  : (a.actor?.name ?? a.actor?.email ?? "system")}
                {a.actorAgent && a.actor?.name && (
                  <> · via {a.actor.name}</>
                )}
                {a.ip && <> · <span className="font-mono">{a.ip}</span></>}
              </div>
            )}
          </div>
        </li>
      ))}
    </Card>
  );
}

function EventsTab() {
  const { data, isLoading } = trpc.admin.events.useQuery({ limit: 100 });
  if (isLoading)
    return (
      <Card>
        <li className="px-4 py-3 text-xs text-muted-foreground">Loading…</li>
      </Card>
    );
  const items = data?.items ?? [];
  if (items.length === 0)
    return (
      <Card>
        <EmptyState
          icon={Activity}
          title="No events yet"
          hint="Issue and project changes publish onto the activity stream here, feeding the timeline and SSE subscribers."
        />
      </Card>
    );
  return (
    <Card>
      {items.map((e) => (
        <li key={e.id} className="flex items-center gap-3 px-4 py-3 text-xs">
          <Badge color="#7c3aed">{e.kind}</Badge>
          <span className="font-mono text-[0.6875rem] text-muted-foreground">
            {e.subjectType}/{e.subjectId.slice(0, 8)}
          </span>
          <span className="ml-auto text-[0.6875rem] text-muted-foreground">
            {relativeTime(e.createdAt)}
          </span>
        </li>
      ))}
    </Card>
  );
}

function DeliveriesTab() {
  const { data, isLoading } = trpc.admin.webhookDeliveries.list.useQuery({
    limit: 100,
  });
  if (isLoading)
    return (
      <Card>
        <li className="px-4 py-3 text-xs text-muted-foreground">Loading…</li>
      </Card>
    );
  const items = data?.items ?? [];
  if (items.length === 0)
    return (
      <Card>
        <EmptyState
          icon={Webhook}
          title="No webhook deliveries"
          hint="Register a plugin webhook or assign an issue to an agent to generate deliveries. The dedicated Deliveries page lets you requeue failures."
        />
      </Card>
    );
  return (
    <Card>
      {items.map((d) => (
        <li key={d.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
          <Badge color={deliveryTone[d.status]}>{d.status}</Badge>
          <span className="truncate font-mono text-[0.6875rem] text-muted-foreground">
            {d.webhook.url}
          </span>
          <span className="text-[0.6875rem] text-muted-foreground">
            {d.event.kind} · attempt {d.attempt}
          </span>
          {d.responseStatus != null && (
            <span className="font-mono text-[0.6875rem] text-muted-foreground">
              HTTP {d.responseStatus}
            </span>
          )}
          <span className="ml-auto text-[0.6875rem] text-muted-foreground">
            {d.deliveredAt
              ? `delivered ${relativeTime(d.deliveredAt)}`
              : `scheduled ${relativeTime(d.scheduledAt)}`}
          </span>
        </li>
      ))}
    </Card>
  );
}
