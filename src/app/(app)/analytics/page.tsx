"use client";
import { Topbar } from "@/components/topbar";
import { trpc } from "@/lib/trpc";

export default function AnalyticsPage() {
  const { data: summary } = trpc.analytics.summary.useQuery();
  const { data: dist } = trpc.analytics.statusDistribution.useQuery();
  const { data: throughput } = trpc.analytics.throughput.useQuery({ granularity: "week", lookbackDays: 84 });
  const { data: cycle } = trpc.analytics.cycleTime.useQuery({ lookbackDays: 90 });
  const { data: breaches } = trpc.analytics.slaBreaches.useQuery();

  return (
    <>
      <Topbar title="Analytics" subtitle="Throughput, cycle time, SLA health" />
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <section className="grid grid-cols-4 gap-3">
          <Stat label="Open" value={summary?.openIssues ?? "—"} />
          <Stat label="Done" value={summary?.doneIssues ?? "—"} />
          <Stat label="Overdue" value={summary?.overdue ?? "—"} tone="warn" />
          <Stat label="Projects" value={summary?.totalProjects ?? "—"} />
        </section>

        <section className="mt-6 grid grid-cols-2 gap-4">
          <Card title="Status distribution">
            <ul className="space-y-1.5">
              {(dist ?? []).map((d) => {
                const max = Math.max(1, ...(dist ?? []).map((x) => x.count));
                return (
                  <li key={d.statusId} className="flex items-center gap-3 text-xs">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: d.color }} />
                    <span className="w-28 truncate">{d.name}</span>
                    <div className="h-1.5 flex-1 rounded-full bg-subtle">
                      <div
                        className="h-1.5 rounded-full"
                        style={{ width: `${(d.count / max) * 100}%`, backgroundColor: d.color }}
                      />
                    </div>
                    <span className="w-8 text-right font-mono tabular-nums">{d.count}</span>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card title="Throughput (weeks completed)">
            <div className="flex h-32 items-end gap-1">
              {(throughput ?? []).map((t) => {
                const max = Math.max(1, ...(throughput ?? []).map((x) => x.completed));
                return (
                  <div
                    key={t.bucket}
                    title={`${t.bucket}: ${t.completed}`}
                    className="flex-1 rounded-sm bg-ember/70 hover:bg-ember"
                    style={{ height: `${(t.completed / max) * 100}%` }}
                  />
                );
              })}
            </div>
          </Card>

          <Card title="Cycle time (hours by priority)">
            <table className="w-full text-xs">
              <thead className="text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="py-1">Priority</th>
                  <th>p50</th>
                  <th>p90</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                {(cycle ?? []).map((r) => (
                  <tr key={r.priority} className="border-t border-border">
                    <td className="py-1">{r.priority}</td>
                    <td className="font-mono tabular-nums">{r.p50}h</td>
                    <td className="font-mono tabular-nums">{r.p90}h</td>
                    <td className="font-mono tabular-nums">{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <Card title="SLA breaches" tone={breaches && breaches.length > 0 ? "warn" : undefined}>
            {breaches && breaches.length === 0 ? (
              <div className="text-xs text-muted-foreground">No active breaches.</div>
            ) : (
              <ul className="space-y-1 text-xs">
                {(breaches ?? []).slice(0, 8).map((b) => (
                  <li key={b.id} className="flex gap-2">
                    <span className="font-mono text-muted-foreground">#{b.number}</span>
                    <span className="truncate">{b.title}</span>
                    <span className="ml-auto font-mono text-danger">
                      +{Math.round(b.breachedBy)}m
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </section>
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "warn" }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "warn" ? "text-warning" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

function Card({
  title,
  tone,
  children,
}: {
  title: string;
  tone?: "warn";
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-4">
      <div
        className={`mb-3 text-[11px] font-semibold uppercase tracking-wider ${tone === "warn" ? "text-warning" : "text-muted-foreground"}`}
      >
        {title}
      </div>
      {children}
    </div>
  );
}
