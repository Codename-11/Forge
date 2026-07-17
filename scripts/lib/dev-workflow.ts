export const LOCAL_DEV = {
  databaseUrl: "postgresql://forge:forge@localhost:55432/forge?schema=public",
  redisUrl: "redis://localhost:56379",
  s3Endpoint: "http://localhost:59000",
  containers: {
    postgres: "forge-dev-postgres",
    redis: "forge-dev-redis",
    minio: "forge-dev-minio",
  },
} as const;

export type DevMode = "start" | "app" | "services" | "refresh" | "reset" | "scenario";

export type DevOptions = {
  mode: DevMode;
  fresh: boolean;
  yes: boolean;
  dryRun: boolean;
  scenario?: string;
  scale: number;
};

export function parseWindowsPnpmEntry(shim: string): string | undefined {
  return shim.match(/%~dp0\\([^"\r\n]*pnpm\.(?:mjs|cjs|js))/i)?.[1];
}

export function parseDevOptions(argv: string[]): DevOptions {
  argv = argv.filter((value) => value !== "--");
  const knownModes: DevMode[] = ["start", "app", "services", "refresh", "reset", "scenario"];
  const mode = knownModes.includes(argv[0] as DevMode) ? (argv.shift() as DevMode) : "start";
  let fresh = mode === "reset";
  let yes = false;
  let dryRun = false;
  let scale = 1;
  let scenario: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    if (value === "--fresh") fresh = true;
    else if (value === "--yes") yes = true;
    else if (value === "--dry-run") dryRun = true;
    else if (value === "--scale") scale = Number(argv[++i]);
    else if (!value.startsWith("-") && mode === "scenario" && !scenario) scenario = value;
    else throw new Error(`Unknown dev option: ${value}`);
  }
  if (!Number.isInteger(scale) || scale < 1 || scale > 100) throw new Error("Scale must be 1-100");
  if (mode === "scenario" && !scenario)
    throw new Error("dev:scenario requires a scenario name or comma-separated names");
  return { mode, fresh, yes, dryRun, scenario, scale };
}

export function assertSafeLocalEnvironment(env: Record<string, string | undefined>): void {
  const guarded = {
    DATABASE_URL: LOCAL_DEV.databaseUrl,
    REDIS_URL: LOCAL_DEV.redisUrl,
    S3_ENDPOINT: LOCAL_DEV.s3Endpoint,
  } as const;
  for (const [name, expected] of Object.entries(guarded)) {
    const actual = env[name];
    if (actual && actual !== expected) {
      throw new Error(`${name} is set to a non-local value; expected exactly ${expected}`);
    }
  }
  for (const [name, expected] of Object.entries(LOCAL_DEV.containers)) {
    const envName = `FORGE_LOCAL_${name.toUpperCase()}_CONTAINER`;
    if (env[envName] && env[envName] !== expected) {
      throw new Error(`${envName} cannot override the guarded local container ${expected}`);
    }
  }
}

export type ServiceState = { exists: boolean; running: boolean; healthy: boolean };

export function servicesToStart(
  states: Record<keyof typeof LOCAL_DEV.containers, ServiceState>,
): string[] {
  return (Object.keys(states) as Array<keyof typeof states>).filter(
    (service) => !states[service].exists || !states[service].running,
  );
}

export type DevDryRunDecision = {
  startServices: string[];
  unavailableServices: string[];
  reconcileSchema: boolean;
  resetDatabase: boolean;
  seedScenario: boolean;
  launchApp: boolean;
};

export function decideDevDryRun(
  options: DevOptions,
  states: Record<keyof typeof LOCAL_DEV.containers, ServiceState>,
): DevDryRunDecision {
  const unavailableServices = (Object.keys(states) as Array<keyof typeof states>).filter(
    (service) => !states[service].running || !states[service].healthy,
  );
  const startServices = options.mode === "app" ? [] : servicesToStart(states);
  return {
    startServices,
    unavailableServices: options.mode === "app" ? unavailableServices : [],
    reconcileSchema: options.mode !== "app" && options.mode !== "services",
    resetDatabase: options.fresh,
    seedScenario: options.mode === "scenario",
    launchApp: options.mode !== "services",
  };
}

export function decidePrismaActions(input: {
  migrationsCurrent: boolean;
  clientCurrent: boolean;
}): { deploy: boolean; generate: boolean } {
  return { deploy: !input.migrationsCurrent, generate: !input.clientCurrent };
}

export function shouldSeedBase(workspaceCount: number): boolean {
  if (!Number.isInteger(workspaceCount) || workspaceCount < 0) {
    throw new Error("Workspace count must be a non-negative integer");
  }
  return workspaceCount === 0;
}
