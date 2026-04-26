"use client";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Webhook, RotateCcw } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/settings/card";
import { EmptyState } from "@/components/settings/empty-state";
import { Section } from "@/components/settings/section";
import { Confirm, SidePanel } from "@/components/ui/modal";
import type { inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers/_app";
import { trpc } from "@/lib/trpc";
import { cn, relativeTime } from "@/lib/utils";

type DeliveryRow =
  inferRouterOutputs<AppRouter>["admin"]["webhookDeliveries"]["list"]["items"][number];

/**
 * Webhook delivery inspector. Lists recent deliveries across the
 * workspace, filterable by status, with a side-panel drill-down that
 * shows the full event payload + response body. Dead-letter rows get a
 * "Retry" action that re-enqueues the delivery onto the BullMQ worker.
 *
 * Admin-only — the tRPC procedures are gated server-side via
 * `adminProcedure`, but we also render a friendly error banner if the
 * caller lacks the role.
 */

type DeliveryStatus = "PENDING" | "SUCCESS" | "FAILED" | "DEAD_LETTER";

const DELIVERY_TONE: Record<DeliveryStatus, string> = {
  PENDING: "#ca8a04",
  SUCCESS: "#65a30d",
  FAILED: "#be185d",
  DEAD_LETTER: "#7c2d12",
};

function truncateUrl(url: string, max = 56): string {
  if (url.length <= max) return url;
  return url.slice(0, max - 1) + "…";
}

function formatWebhookKind(webhook: {
  url: string;
  pluginId: string | null;
}): string {
  if (webhook.url.startsWith("agent:dispatch")) return "agent";
  if (webhook.pluginId) return "plugin";
  return "workspace";
}

export default function WebhookDeliveriesPage() {
  const [status, setStatus] = useState<DeliveryStatus | undefined>(
    "DEAD_LETTER",
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [retryTarget, setRetryTarget] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const { data, isLoading, error } = trpc.admin.webhookDeliveries.list.useQuery(
    { status, limit: 50 },
  );

  const retry = trpc.admin.webhookDeliveries.retry.useMutation({
    onSuccess: () => {
      toast.success("Delivery requeued.");
      setRetryTarget(null);
      utils.admin.webhookDeliveries.list.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const items = useMemo(() => data?.items ?? [], [data?.items]);
  const selected = useMemo(
    () => items.find((d) => d.id === selectedId) ?? null,
    [items, selectedId],
  );

  if (error) {
    const msg = error.message.includes("Admin")
      ? "Admin role required to view this page."
      : error.message;
    return (
      <>
        <Topbar
          title="Webhook deliveries"
          subtitle="Inspect and requeue failed webhook deliveries."
        />
        <div className="mx-auto max-w-5xl p-6 text-sm text-muted-foreground">
          {msg}
        </div>
      </>
    );
  }

  return (
    <>
      <Topbar
        title="Webhook deliveries"
        subtitle="Inspect and requeue failed webhook deliveries."
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl space-y-6 p-6">
          <Section
            title="Deliveries"
            hint="Rows reflect the durable queue. Retries reset attempt count and push back onto the worker."
            actions={
              <div className="flex gap-1 rounded-md bg-subtle p-0.5 text-[0.6875rem]">
                <FilterChip
                  label="Dead letter"
                  active={status === "DEAD_LETTER"}
                  onClick={() => setStatus("DEAD_LETTER")}
                />
                <FilterChip
                  label="Failed"
                  active={status === "FAILED"}
                  onClick={() => setStatus("FAILED")}
                />
                <FilterChip
                  label="Pending"
                  active={status === "PENDING"}
                  onClick={() => setStatus("PENDING")}
                />
                <FilterChip
                  label="Success"
                  active={status === "SUCCESS"}
                  onClick={() => setStatus("SUCCESS")}
                />
                <FilterChip
                  label="All"
                  active={status === undefined}
                  onClick={() => setStatus(undefined)}
                />
              </div>
            }
          >
            {isLoading ? (
              <Card>
                <li className="px-4 py-3 text-xs text-muted-foreground">
                  Loading…
                </li>
              </Card>
            ) : items.length === 0 ? (
              <Card>
                <EmptyState
                  icon={Webhook}
                  title={
                    status
                      ? `No ${status.toLowerCase().replace("_", " ")} deliveries`
                      : "No deliveries yet"
                  }
                  hint="Register a plugin webhook or assign an issue to an agent to generate these."
                />
              </Card>
            ) : (
              <Card>
                <li className="grid grid-cols-[1fr_1.25fr_5rem_5rem_1fr_7rem] items-center gap-3 border-b border-border bg-subtle/30 px-4 py-2 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
                  <span>Event</span>
                  <span>Endpoint</span>
                  <span>Status</span>
                  <span className="tabular-nums">Attempts</span>
                  <span>Last error / response</span>
                  <span className="text-right">Time</span>
                </li>
                {items.map((d) => {
                  const err = errorSummary(d);
                  return (
                    <li
                      key={d.id}
                      onClick={() => setSelectedId(d.id)}
                      className={cn(
                        "grid grid-cols-[1fr_1.25fr_5rem_5rem_1fr_7rem] cursor-pointer items-center gap-3 px-4 py-2.5 text-xs hover:bg-subtle/60",
                        selectedId === d.id && "bg-subtle/60",
                      )}
                    >
                      <div className="min-w-0">
                        <div className="font-mono text-[0.6875rem] text-foreground">
                          {d.event.kind}
                        </div>
                        <div className="truncate text-[0.6875rem] text-muted-foreground">
                          {d.event.subjectType}/{d.event.subjectId.slice(0, 8)}
                        </div>
                      </div>
                      <div className="min-w-0">
                        <div className="truncate font-mono text-[0.6875rem] text-foreground">
                          {truncateUrl(d.webhook.url, 48)}
                        </div>
                        <div className="text-[0.6875rem] text-muted-foreground">
                          {formatWebhookKind(d.webhook)}
                        </div>
                      </div>
                      <div>
                        <Badge color={DELIVERY_TONE[d.status as DeliveryStatus]}>
                          {d.status}
                        </Badge>
                      </div>
                      <div className="font-mono tabular-nums text-[0.6875rem] text-muted-foreground">
                        {d.attempt}
                      </div>
                      <div className="min-w-0 truncate text-[0.6875rem] text-muted-foreground">
                        {err ?? "—"}
                      </div>
                      <div className="text-right text-[0.6875rem] text-muted-foreground">
                        {d.deliveredAt
                          ? relativeTime(d.deliveredAt)
                          : relativeTime(d.scheduledAt)}
                      </div>
                    </li>
                  );
                })}
              </Card>
            )}
          </Section>
        </div>
      </div>

      <SidePanel
        open={selected !== null}
        onOpenChange={(o) => !o && setSelectedId(null)}
        size="wide"
        title={
          selected ? (
            <span className="font-mono">{selected.event.kind}</span>
          ) : (
            ""
          )
        }
        description={
          selected ? (
            <span className="font-mono text-muted-foreground">
              {selected.id}
            </span>
          ) : undefined
        }
        footer={
          selected ? (
            <>
              <div className="mr-auto text-[0.6875rem] text-muted-foreground">
                Attempt {selected.attempt} ·{" "}
                {selected.deliveredAt
                  ? `delivered ${relativeTime(selected.deliveredAt)}`
                  : `scheduled ${relativeTime(selected.scheduledAt)}`}
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSelectedId(null)}
              >
                Close
              </Button>
              {selected.status === "DEAD_LETTER" && (
                <Button
                  type="button"
                  variant="ember"
                  size="sm"
                  onClick={() => setRetryTarget(selected.id)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Retry
                </Button>
              )}
            </>
          ) : undefined
        }
      >
        {selected && <DeliveryDetail d={selected} />}
      </SidePanel>

      <Confirm
        open={retryTarget !== null}
        onOpenChange={(o) => !o && setRetryTarget(null)}
        title="Requeue delivery?"
        description="This resets the attempt counter to zero and pushes the delivery back onto the worker queue. It will fire a fresh HTTP request against the configured webhook URL."
        primaryLabel="Requeue"
        loading={retry.isPending}
        onConfirm={async () => {
          if (!retryTarget) return;
          await retry.mutateAsync({ id: retryTarget });
        }}
      />
    </>
  );
}

function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "focus-ring rounded px-2 py-1 transition-colors",
        active
          ? "bg-background text-foreground shadow-sm"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
    </button>
  );
}

function errorSummary(d: DeliveryRow): string | null {
  if (d.status === "SUCCESS") return null;
  if (d.responseStatus != null)
    return `HTTP ${d.responseStatus}${
      d.responseBody ? ` · ${d.responseBody.slice(0, 80)}` : ""
    }`;
  if (d.responseBody) return d.responseBody.slice(0, 120);
  return null;
}

function DeliveryDetail({ d }: { d: DeliveryRow }) {
  return (
    <div className="space-y-4 text-xs">
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <Badge color={DELIVERY_TONE[d.status as DeliveryStatus]}>
            {d.status}
          </Badge>
        </Field>
        <Field label="Attempts">
          <span className="font-mono tabular-nums">{d.attempt}</span>
        </Field>
        <Field label="Scheduled">
          <span className="text-muted-foreground">
            {new Date(d.scheduledAt).toISOString()}
          </span>
        </Field>
        <Field label="Delivered">
          <span className="text-muted-foreground">
            {d.deliveredAt ? new Date(d.deliveredAt).toISOString() : "—"}
          </span>
        </Field>
      </div>

      <Field label="Webhook">
        <div className="space-y-0.5">
          <div className="break-all font-mono text-[0.6875rem] text-foreground">
            {d.webhook.url}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            {formatWebhookKind(d.webhook)}
            {d.webhook.events.length > 0 && (
              <> · subscribes to {d.webhook.events.length} event kinds</>
            )}
          </div>
        </div>
      </Field>

      <Field label="Event">
        <div className="space-y-0.5">
          <div className="font-mono text-[0.6875rem] text-foreground">
            {d.event.kind} on {d.event.subjectType}/{d.event.subjectId}
          </div>
          <div className="text-[0.6875rem] text-muted-foreground">
            fired {relativeTime(d.event.createdAt)}
          </div>
        </div>
      </Field>

      <Field label="Response">
        {d.responseStatus != null ? (
          <div className="space-y-1">
            <div className="font-mono text-[0.6875rem]">
              HTTP {d.responseStatus}
            </div>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 p-2 font-mono text-[0.6875rem] text-muted-foreground">
              {d.responseBody ?? "(empty body)"}
            </pre>
          </div>
        ) : d.responseBody ? (
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 p-2 font-mono text-[0.6875rem] text-muted-foreground">
            {d.responseBody}
          </pre>
        ) : (
          <div className="text-[0.6875rem] text-muted-foreground">
            No response recorded.
          </div>
        )}
      </Field>

      <Field label="Payload">
        <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded-md border border-border bg-background/60 p-2 font-mono text-[0.6875rem] text-muted-foreground">
          {JSON.stringify(d.event.payload, null, 2)}
        </pre>
      </Field>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div>{children}</div>
    </div>
  );
}
