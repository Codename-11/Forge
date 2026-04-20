import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { NextRequest } from "next/server";
import { appRouter } from "@/server/routers/_app";
import { createContext } from "@/server/trpc";
import { logger } from "@/server/logger";

const handler = (req: NextRequest) =>
  fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext(req),
    onError({ error, path, type, input }) {
      // Log every tRPC error in every env. In prod this is the only way we
      // hear about failing procedures — the client only sees TRPCClientError
      // with no stack. Keep it structured so grepping `docker logs forge`
      // pulls them out cleanly.
      logger.error(
        {
          path,
          type,
          code: error.code,
          cause: error.cause instanceof Error ? error.cause.message : undefined,
          stack: error.stack,
          // Input is superjson-encoded; stringify defensively.
          input: safeStringify(input),
        },
        `trpc error: ${path ?? "<unknown>"} ${error.code}`,
      );
    },
  });

function safeStringify(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  try {
    return JSON.stringify(v).slice(0, 500);
  } catch {
    return "<unserializable>";
  }
}

export { handler as GET, handler as POST };
