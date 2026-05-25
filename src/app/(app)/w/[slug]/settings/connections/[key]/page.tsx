"use client";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import {
  ArrowRight,
  ChevronLeft,
  KeyRound,
  Lock,
  PlugZap,
} from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Section } from "@/components/settings/section";
import { Card } from "@/components/settings/card";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "@/hooks/use-workspace";
import { findConnection } from "@/lib/connections-registry";

/**
 * Connection detail (design artboard 38).
 *
 * Design-faithful SHELL only. With one exception, no connection here has
 * a backend yet, so this page is deliberately honest: it renders the
 * connection's contract (what it does, direction, transport) and a
 * "backend pending" Configuration state instead of fabricating repos,
 * deliveries, or sync rules. Nothing on this page writes — the Connect
 * button is disabled for `available` items, and the danger-zone
 * Disconnect only appears for `connected` items (and is itself inert,
 * since the disconnect mutation does not exist yet).
 *
 * The one real channel — email-to-issue (`email-issue`) — has live
 * controls on the Connections index. Its detail page links back there
 * rather than duplicating the mutation surface.
 */
export default function ConnectionDetailPage() {
  const ws = useWorkspace();
  const params = useParams<{ key: string }>();
  const found = findConnection(params.key);
  if (!found) notFound();

  const { connection: c, direction } = found;
  const Icon = c.icon;
  const isReal = c.key === "email-issue";
  const isConnected = c.status === "connected";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        title={
          <span className="flex items-center gap-2">
            <Icon className="h-3.5 w-3.5 text-foreground" />
            {c.title}
            <StatusBadge status={c.status} />
            {c.beta && (
              <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
                beta
              </span>
            )}
          </span>
        }
        subtitle={c.blurb}
        actions={
          <Link
            href={`/w/${ws.slug}/settings/connections`}
            className="inline-flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            All connections
          </Link>
        }
      />

      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Breadcrumb-ish */}
          <nav className="flex items-center gap-1.5 px-1 text-meta text-muted-foreground">
            <Link
              href={`/w/${ws.slug}/settings/connections`}
              className="hover:text-foreground"
            >
              Connections
            </Link>
            <ArrowRight className="h-2.5 w-2.5" />
            <span className="text-foreground">{c.title}</span>
          </nav>

          {/* Overview */}
          <Section
            title="Overview"
            hint="What this connection does and how data flows."
          >
            <Card as="div">
              <dl className="grid grid-cols-1 gap-px overflow-hidden rounded-lg bg-border sm:grid-cols-3">
                <OverviewCell label="Direction">
                  <span className="inline-flex items-center gap-1 text-sm">
                    {direction === "in" ? (
                      <>
                        <span className="text-muted-foreground">external</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="text-ember">Forge</span>
                      </>
                    ) : (
                      <>
                        <span className="text-ember">Forge</span>
                        <ArrowRight className="h-3 w-3 text-muted-foreground" />
                        <span className="text-muted-foreground">external</span>
                      </>
                    )}
                  </span>
                </OverviewCell>
                <OverviewCell label="Transport">
                  <span className="font-mono text-sm text-foreground">
                    {c.transport}
                  </span>
                </OverviewCell>
                <OverviewCell label="Status">
                  <StatusBadge status={c.status} />
                </OverviewCell>
              </dl>
              <p className="border-t border-border p-4 text-[0.8125rem] text-muted-foreground">
                {c.blurb}{" "}
                {direction === "in"
                  ? "This is an inbound channel — the external system pushes work into Forge."
                  : "This is an outbound channel — Forge pushes events to the external system."}
              </p>
            </Card>
          </Section>

          {/* Configuration */}
          {isReal ? (
            <RealEmailIssueSection slug={ws.slug} />
          ) : (
            <PlaceholderConfigSection
              connectVerb={isConnected ? "Configure" : "Connect"}
              transport={c.transport}
            />
          )}

          {/* Danger zone — only for connected channels */}
          {isConnected && !isReal && (
            <Section title="Danger zone">
              <div className="rounded-lg border border-danger/30 bg-danger/5">
                <div className="flex items-start justify-between gap-4 p-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      Disconnect {c.title}
                    </div>
                    <p className="mt-0.5 text-meta text-muted-foreground">
                      Stops syncing. Existing linked issues stay in Forge.
                      Re-connecting rewires them.
                    </p>
                    <p className="mt-1 text-[0.6875rem] text-muted-foreground/70">
                      Type{" "}
                      <code className="font-mono text-foreground/80">
                        DISCONNECT
                      </code>{" "}
                      to confirm. Backend pending — this control is inert.
                    </p>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    disabled
                    title="Disconnect mutation not yet wired."
                  >
                    Disconnect
                  </Button>
                </div>
              </div>
            </Section>
          )}
        </div>
      </div>
    </div>
  );
}

function OverviewCell({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5">{children}</div>
    </div>
  );
}

/**
 * Honest placeholder for the not-yet-wired connections. No fabricated
 * repos/events/deliveries — just the contract and a clearly-disabled
 * Connect button.
 */
function PlaceholderConfigSection({
  connectVerb,
  transport,
}: {
  connectVerb: string;
  transport: string;
}) {
  return (
    <Section
      title="Configuration"
      hint="Connect this integration to configure sync rules, events, and delivery."
    >
      <Card as="div">
        <div className="flex flex-col items-center gap-3 p-8 text-center">
          <span className="grid h-11 w-11 place-items-center rounded-lg bg-subtle">
            <PlugZap className="h-4 w-4 text-muted-foreground" />
          </span>
          <div className="space-y-1">
            <div className="text-sm font-semibold text-foreground">
              Not yet connected
            </div>
            <p className="mx-auto max-w-md text-meta text-muted-foreground">
              Upstream wiring for this channel ships in a future run. Once
              connected over{" "}
              <span className="font-mono text-foreground/80">{transport}</span>,
              this page surfaces sync rules, the event subscription, and a
              delivery log.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled
            title="Upstream wiring lands in a future run."
            className="mt-1"
          >
            <Lock className="h-3 w-3" />
            {connectVerb} (backend pending)
          </Button>
        </div>
      </Card>
    </Section>
  );
}

/**
 * Email-to-issue is the only channel with a live backend; its real
 * controls live on the Connections index. Link back rather than
 * duplicate the mutation surface here.
 */
function RealEmailIssueSection({ slug }: { slug: string }) {
  return (
    <Section
      title="Configuration"
      hint="Email-to-issue has a live backend — its controls live on the Connections index."
    >
      <Card as="div">
        <div className="flex items-start gap-3 p-4">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-subtle">
            <KeyRound className="h-3.5 w-3.5 text-foreground" />
          </span>
          <div className="min-w-0 flex-1 space-y-2">
            <div className="text-sm font-semibold text-foreground">
              Live controls available
            </div>
            <p className="text-[0.8125rem] text-muted-foreground">
              This is the one inbound channel with a real endpoint
              (<code className="font-mono">/api/ingest/email</code>). Enable
              ingestion, rotate the HMAC secret, and copy the target inbox from
              the Email-to-issue card on the Connections index.
            </p>
            <Link
              href={`/w/${slug}/settings/connections`}
              className="inline-flex items-center gap-1 text-meta text-ember hover:underline"
            >
              Open email-to-issue controls
              <ArrowRight className="h-3 w-3" />
            </Link>
          </div>
        </div>
      </Card>
    </Section>
  );
}

function StatusBadge({
  status,
}: {
  status: "connected" | "available" | "needs auth";
}) {
  if (status === "connected") {
    return (
      <span className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-emerald-700 dark:text-emerald-400">
        connected
      </span>
    );
  }
  if (status === "needs auth") {
    return (
      <span className="rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-warning">
        needs auth
      </span>
    );
  }
  return (
    <span className="rounded-md border border-border bg-subtle/40 px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-wider text-muted-foreground">
      available
    </span>
  );
}
