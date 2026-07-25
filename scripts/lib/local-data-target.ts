import { fileURLToPath } from "node:url";

export const LOCAL_DATABASE_URL = "postgresql://forge:forge@localhost:55432/forge?schema=public";
export const LOCAL_TEST_DATABASE_URL =
  "postgresql://forge:forge@localhost:55432/forge_test?schema=public";
export const LOCAL_DATABASE_CONTAINER = "forge-dev-postgres";

export type LocalTarget = {
  host: string;
  port: string;
  database: string;
  user: string;
  schema: string;
  container: string;
};

export function validateLocalTarget(
  databaseUrl: string,
  container = LOCAL_DATABASE_CONTAINER,
): LocalTarget {
  const url = new URL(databaseUrl);
  const target = {
    host: url.hostname,
    port: url.port,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    schema: url.searchParams.get("schema") ?? "",
    container,
  };
  const expected = {
    host: "localhost",
    port: "55432",
    database: "forge",
    user: "forge",
    schema: "public",
    container: LOCAL_DATABASE_CONTAINER,
  };
  const mismatches = Object.entries(expected)
    .filter(([key, value]) => target[key as keyof LocalTarget] !== value)
    .map(([key, value]) => `${key} must be ${value}`);
  if (url.protocol !== "postgresql:") mismatches.unshift("protocol must be postgresql:");
  if (url.password !== "forge") mismatches.push("password must be the local development password");
  if (mismatches.length > 0) {
    throw new Error(`Refusing destructive database operation: ${mismatches.join("; ")}`);
  }
  return target;
}

export function formatLocalTarget(target: LocalTarget): string {
  return [
    `container=${target.container}`,
    `host=${target.host}:${target.port}`,
    `database=${target.database}`,
    `schema=${target.schema}`,
    `user=${target.user}`,
  ].join(" ");
}

export function validateLocalScenarioTarget(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const database = url.pathname.replace(/^\//, "");
  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "localhost" ||
    url.port !== "55432" ||
    decodeURIComponent(url.username) !== "forge" ||
    decodeURIComponent(url.password) !== "forge" ||
    url.searchParams.get("schema") !== "public" ||
    !["forge", "forge_e2e", "forge_lifecycle"].includes(database)
  ) {
    throw new Error(
      "Named scenarios require the exact Forge local docker host, port, database, credentials, and public schema",
    );
  }
}

export function validateLocalTestTarget(databaseUrl: string): LocalTarget {
  const url = new URL(databaseUrl);
  const target = {
    host: url.hostname,
    port: url.port,
    database: url.pathname.replace(/^\//, ""),
    user: decodeURIComponent(url.username),
    schema: url.searchParams.get("schema") ?? "",
    container: LOCAL_DATABASE_CONTAINER,
  };
  const valid =
    url.protocol === "postgresql:" &&
    target.host === "localhost" &&
    target.port === "55432" &&
    target.database === "forge_test" &&
    target.user === "forge" &&
    decodeURIComponent(url.password) === "forge" &&
    target.schema === "public";
  if (!valid) {
    throw new Error("Local CI requires the exact disposable forge_test database target");
  }
  return target;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    console.log(formatLocalTarget(validateLocalTarget(process.argv[2] ?? "")));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
