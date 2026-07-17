export type TrpcLogDecision = {
  direction: "up" | "down";
  result?: unknown;
};

export function verboseTrpcLoggingEnabled(value = process.env.NEXT_PUBLIC_TRPC_VERBOSE): boolean {
  return value === "1" || value === "true";
}

/** Keep failures visible while making successful request logging explicitly opt-in. */
export function shouldLogTrpcOperation(
  operation: TrpcLogDecision,
  verbose = verboseTrpcLoggingEnabled(),
): boolean {
  return verbose || (operation.direction === "down" && operation.result instanceof Error);
}
