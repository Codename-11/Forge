"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { Clock, Download } from "lucide-react";
import { Topbar } from "@/components/topbar";
import { Button } from "@/components/ui/button";
import { EmptyState, SkeletonList } from "@/components/ui";
import { trpc } from "@/lib/trpc";
import { formatIssueId } from "@/lib/utils";
import { useWorkspace } from "@/hooks/use-workspace";

/**
 * Time log page. Table of recent entries + filter bar + CSV export.
 *
 * Feature-flagged on `workspace.timeTrackingEnabled`. Non-admins see
 * only their own entries (server enforces by default when `userId` is
 * absent). Admins can switch the `userId` filter to pull anyone's log.
 */
export default function TimeLogPage() {
  const workspace = useWorkspace();
  const isAdmin =
    workspace.role === "OWNER" || workspace.role === "ADMIN";

  const today = useMemo(() => new Date(), []);
  const defaultFrom = useMemo(() => {
    const d = new Date(today);
    d.setDate(d.getDate() - 30);
    d.setHours(0, 0, 0, 0);
    return d;
  }, [today]);
  const defaultTo = useMemo(() => {
    const d = new Date(today);
    d.setHours(23, 59, 59, 999);
    return d;
  }, [today]);

  const [from, setFrom] = useState<Date>(defaultFrom);
  const [to, setTo] = useState<Date>(defaultTo);
  const [billableOnly, setBillableOnly] = useState(false);
  const [userId, setUserId] = useState<string | undefined>(undefined);

  const { data: members } = trpc.workspace.members.useQuery(undefined, {
    enabled: isAdmin,
  });

  const listInput = useMemo(
    () => ({
      from,
      to,
      billable: billableOnly ? true : undefined,
      userId,
      limit: 500 as const,
    }),
    [from, to, billableOnly, userId],
  );
  const { data: entries, isLoading } = trpc.timeEntry.list.useQuery(listInput);

  const rows = useMemo(() => entries ?? [], [entries]);
  const totals = useMemo(() => {
    let minutes = 0;
    let billableAmount = 0;
    for (const e of rows) {
      if (!e.endedAt) continue;
      const mm = Math.max(
        0,
        Math.round((new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime()) / 60_000),
      );
      minutes += mm;
      if (e.billable && e.hourlyRate) {
        billableAmount += (mm / 60) * e.hourlyRate;
      }
    }
    return {
      minutes,
      billableAmount: Math.round(billableAmount * 100) / 100,
    };
  }, [rows]);

  // Utility — uses utils.client to call the exportCsv query imperatively,
  // because it's a query (not a mutation) and we want to trigger a file
  // download on demand.
  const utils = trpc.useUtils();

  async function downloadCsv() {
    try {
      const csv = await utils.timeEntry.exportCsv.fetch({ from, to, userId });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `time-${from.toISOString().slice(0, 10)}-${to.toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Export failed";
      alert(msg);
    }
  }

  return (
    <>
      <Topbar
        title="Time log"
        subtitle="Your entries within the selected range."
        actions={
          <Button variant="outline" size="sm" onClick={downloadCsv}>
            <Download className="h-3.5 w-3.5" /> Export CSV
          </Button>
        }
      />
      <div className="flex flex-wrap items-end gap-3 border-b border-border bg-card/20 px-5 py-3 text-xs">
        <DateField
          label="From"
          value={from}
          onChange={(d) => setFrom(d)}
        />
        <DateField
          label="To"
          value={to}
          onChange={(d) => setTo(d)}
        />
        <label className="flex items-center gap-2 pb-0.5">
          <input
            type="checkbox"
            checked={billableOnly}
            onChange={(e) => setBillableOnly(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Billable only
        </label>
        {isAdmin && (
          <label className="flex flex-col gap-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
            Assignee
            <select
              value={userId ?? ""}
              onChange={(e) => setUserId(e.target.value || undefined)}
              className="focus-ring h-7 rounded-md border border-input bg-background px-2 text-[0.75rem] normal-case tracking-normal text-foreground"
            >
              <option value="">Everyone</option>
              {(members ?? []).map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.name ?? m.user.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ml-auto flex items-center gap-4 font-mono text-[0.6875rem]">
          <span>
            <span className="text-muted-foreground">Total:</span>{" "}
            {formatMinutes(totals.minutes)}
          </span>
          <span>
            <span className="text-muted-foreground">Billable:</span>{" "}
            ${totals.billableAmount.toFixed(2)}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="p-4">
            <SkeletonList rows={8} />
          </div>
        ) : rows.length === 0 ? (
          <div className="flex items-center justify-center p-8">
            <EmptyState
              variant="section"
              icon={<Clock />}
              title="No time entries in this range."
              description="Try a wider date range, or start the timer from any issue detail (press T)."
            />
          </div>
        ) : (
          <table className="w-full text-[0.75rem]">
            <thead className="sticky top-0 z-10 bg-card/80 text-[0.6875rem] uppercase tracking-wider text-muted-foreground backdrop-blur">
              <tr>
                <th className="px-5 py-2 text-left font-medium">Date</th>
                <th className="px-3 py-2 text-left font-medium">Issue</th>
                <th className="px-3 py-2 text-left font-medium">Description</th>
                <th className="px-3 py-2 text-right font-medium">Duration</th>
                <th className="px-3 py-2 text-center font-medium">Billable</th>
                <th className="px-3 py-2 text-right font-medium">Rate</th>
                <th className="px-5 py-2 text-right font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {rows.map((e) => {
                const end = e.endedAt ? new Date(e.endedAt) : null;
                const minutes = end
                  ? Math.max(
                      0,
                      Math.round(
                        (end.getTime() - new Date(e.startedAt).getTime()) / 60_000,
                      ),
                    )
                  : 0;
                const amount =
                  e.billable && e.hourlyRate
                    ? Math.round(((minutes / 60) * e.hourlyRate) * 100) / 100
                    : 0;
                return (
                  <tr key={e.id} className="hover:bg-subtle/40">
                    <td className="px-5 py-2 font-mono text-[0.6875rem] text-muted-foreground">
                      {new Date(e.startedAt).toLocaleDateString()}
                    </td>
                    <td className="px-3 py-2">
                      {e.issue ? (
                        <Link
                          href={`/w/${workspace.slug}/issues/${e.issue.id}`}
                          className="font-mono text-[0.6875rem] hover:underline"
                        >
                          {formatIssueId(workspace.key, e.issue.number)}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="max-w-[320px] truncate">
                        {e.issue?.title ?? e.description ?? ""}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">
                      {end ? formatMinutes(minutes) : "·running·"}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {e.billable ? (
                        <span className="rounded bg-success/10 px-1.5 py-0.5 text-[0.6875rem] text-success">
                          yes
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-muted-foreground">
                      {e.hourlyRate ? `$${e.hourlyRate}` : "—"}
                    </td>
                    <td className="px-5 py-2 text-right font-mono">
                      {amount > 0 ? `$${amount.toFixed(2)}` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: Date;
  onChange: (next: Date) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-[0.6875rem] uppercase tracking-wider text-muted-foreground">
      {label}
      <input
        type="date"
        value={value.toISOString().slice(0, 10)}
        onChange={(e) => {
          const d = new Date(e.target.value);
          if (!isNaN(d.getTime())) {
            if (label === "To") d.setHours(23, 59, 59, 999);
            else d.setHours(0, 0, 0, 0);
            onChange(d);
          }
        }}
        className="focus-ring h-7 rounded-md border border-input bg-background px-2 font-mono text-[0.6875rem] normal-case tracking-normal text-foreground"
      />
    </label>
  );
}

function formatMinutes(m: number): string {
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}
