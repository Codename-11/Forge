"use client";
import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, loggerLink } from "@trpc/client";
import superjson from "superjson";
import { trpc } from "@/lib/trpc";

export function TrpcProvider({
  children,
  workspaceId,
}: {
  children: ReactNode;
  workspaceId?: string | null;
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
        loggerLink({ enabled: (opts) => process.env.NODE_ENV === "development" || opts.direction === "down" && opts.result instanceof Error }),
        httpBatchLink({
          url: "/api/trpc",
          transformer: superjson,
          headers: () => (workspaceId ? { "x-workspace-id": workspaceId } : {}),
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
