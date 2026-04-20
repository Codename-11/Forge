"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";

/**
 * Client-side tRPC provider.
 *
 * Workspace scoping is sent on every request. Priority order for the header:
 *   1. Slug embedded in the URL (`/w/[slug]/...`) — always the source of
 *      truth once the shell has mounted the user inside a workspace.
 *   2. Explicit `workspaceSlug` prop (e.g. the RSC layout injects it so
 *      the *first* request knows the slug before client hydration runs).
 *   3. Explicit `workspaceId` prop (legacy callers like the focus page
 *      that bootstrap without URL context).
 *
 * Reading from `window.location` means the switcher only has to
 * `router.push` a new slug — the next round-trip is automatically scoped
 * to the new workspace without a full React tree re-mount.
 */
export function TrpcProvider({
  children,
  workspaceId,
  workspaceSlug,
}: {
  children: ReactNode;
  workspaceId?: string | null;
  workspaceSlug?: string | null;
}) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 30_000, refetchOnWindowFocus: false },
        },
      }),
  );
  const [client] = useState(() =>
    trpc.createClient({
      links: [
        loggerLink({
          enabled: (opts) =>
            process.env.NODE_ENV === "development" ||
            (opts.direction === "down" && opts.result instanceof Error),
        }),
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
          headers: () => {
            const headers: Record<string, string> = {};
            // URL slug takes precedence once the shell is mounted.
            const urlSlug = readSlugFromLocation();
            const cookieSlug = readSlugFromCookie();
            const slug = urlSlug ?? workspaceSlug ?? cookieSlug ?? null;
            if (slug) headers["x-workspace-slug"] = slug;
            if (!slug && workspaceId) headers["x-workspace-id"] = workspaceId;
            return headers;
          },
        }),
      ],
    }),
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

function readSlugFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const m = window.location.pathname.match(/^\/w\/([^/]+)(?:\/|$)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

function readSlugFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(/(?:^|; )forge\.lastSlug=([^;]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}
