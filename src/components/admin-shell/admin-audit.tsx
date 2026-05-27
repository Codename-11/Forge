"use client";
import { trpc } from "@/lib/trpc";
import { ADMIN, AdminPanel, AdminLoading, AdminEmpty, AdminButton, relTime } from "./admin-ui";

/**
 * Cross-tenant audit feed for `/admin/audit`. Reads `instanceAdmin.audit`
 * (cursor-paginated) via tRPC `useInfiniteQuery` with a "Load more"
 * button. Part of the multi-workspace restructure.
 */
export function AdminAudit() {
  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    trpc.instanceAdmin.audit.useInfiniteQuery(
      { limit: 60 },
      { getNextPageParam: (last) => last.nextCursor },
    );

  const items = data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="mx-auto w-full max-w-[1280px] px-8 py-6">
      <AdminPanel title="Audit log" hint="cross-tenant activity">
        <div
          className="grid grid-cols-[0.6fr_1fr_1.4fr_1fr_0.5fr] items-center gap-2 px-4 py-2 text-meta"
          style={{ color: ADMIN.textMuted, borderBottom: `1px solid ${ADMIN.border}` }}
        >
          <span>Tenant</span>
          <span>Event</span>
          <span>Subject</span>
          <span>Actor</span>
          <span className="text-right">When</span>
        </div>
        {isLoading ? (
          <AdminLoading />
        ) : !items.length ? (
          <AdminEmpty>No activity recorded.</AdminEmpty>
        ) : (
          <>
            {items.map((e, i) => (
              <div
                key={e.id}
                className="grid grid-cols-[0.6fr_1fr_1.4fr_1fr_0.5fr] items-center gap-2 px-4 py-2"
                style={{ borderBottom: i === items.length - 1 ? "none" : `1px solid ${ADMIN.borderRow}` }}
              >
                <span className="min-w-0">
                  <span
                    className="inline-flex items-center rounded px-1 text-[10px] font-mono"
                    style={{ background: "var(--admin-border)", color: ADMIN.textSoft }}
                    title={e.workspace?.name ?? undefined}
                  >
                    {e.workspace?.key ?? "—"}
                  </span>
                </span>
                <span className="truncate text-meta font-mono" style={{ color: "hsl(var(--admin-text-hi))" }}>
                  {e.kind.toLowerCase()}
                </span>
                <span className="truncate text-meta" style={{ color: ADMIN.textSoft }}>
                  {e.subjectType}
                  {e.subjectId ? <span style={{ color: ADMIN.textDim }}> · {e.subjectId.slice(0, 8)}</span> : null}
                </span>
                <span className="truncate text-meta" style={{ color: ADMIN.textSoft }}>
                  {e.actor?.name ?? "system"}
                </span>
                <span className="text-right text-meta tabular-nums" style={{ color: ADMIN.textMuted }}>
                  {relTime(e.createdAt)}
                </span>
              </div>
            ))}
            <div className="flex items-center justify-center px-4 py-3" style={{ borderTop: `1px solid ${ADMIN.border}` }}>
              {hasNextPage ? (
                <AdminButton disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                  {isFetchingNextPage ? "Loading…" : "Load more"}
                </AdminButton>
              ) : (
                <span className="text-meta" style={{ color: ADMIN.textDim }}>
                  End of feed
                </span>
              )}
            </div>
          </>
        )}
      </AdminPanel>
    </div>
  );
}
