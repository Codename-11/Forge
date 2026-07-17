export const SCENARIO_NAMES = [
  "delivery-github",
  "status-freshness",
  "activity-overflow",
  "tenancy",
  "invitations-concurrency",
  "large-workspace",
] as const;

export type ScenarioName = (typeof SCENARIO_NAMES)[number];

export type ScenarioPlan = {
  name: ScenarioName;
  scale: number;
  issueCount: number;
  eventCount: number;
  description: string;
};

const definitions: Record<
  ScenarioName,
  Omit<ScenarioPlan, "name" | "scale"> & {
    scaleIssues: number;
    scaleEvents: number;
  }
> = {
  "delivery-github": {
    issueCount: 2,
    eventCount: 0,
    scaleIssues: 0,
    scaleEvents: 0,
    description: "native IMPLEMENTS provenance with open, merged, and review/check states",
  },
  "status-freshness": {
    issueCount: 4,
    eventCount: 0,
    scaleIssues: 0,
    scaleEvents: 0,
    description: "fresh, quiet, stale, and waiting agent delivery states",
  },
  "activity-overflow": {
    issueCount: 1,
    eventCount: 24,
    scaleIssues: 0,
    scaleEvents: 24,
    description: "adjacent grouping plus enough activity to exercise overflow controls",
  },
  tenancy: {
    issueCount: 2,
    eventCount: 0,
    scaleIssues: 0,
    scaleEvents: 0,
    description: "a second isolated workspace with overlapping-looking content",
  },
  "invitations-concurrency": {
    issueCount: 3,
    eventCount: 0,
    scaleIssues: 3,
    scaleEvents: 0,
    description: "invitation lifecycle, member roster, and work around a bounded concurrency cap",
  },
  "large-workspace": {
    issueCount: 50,
    eventCount: 0,
    scaleIssues: 50,
    scaleEvents: 0,
    description: "large deterministic issue population for query and rendering performance",
  },
};

export function parseScenarioNames(value?: string): ScenarioName[] {
  if (!value || value === "all") return [...SCENARIO_NAMES];
  const names = [
    ...new Set(
      value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean),
    ),
  ];
  const unknown = names.filter((name) => !SCENARIO_NAMES.includes(name as ScenarioName));
  if (unknown.length > 0) throw new Error(`Unknown scenario(s): ${unknown.join(", ")}`);
  return names as ScenarioName[];
}

export function buildScenarioPlan(names: ScenarioName[], scale = 1): ScenarioPlan[] {
  if (!Number.isInteger(scale) || scale < 1 || scale > 100) {
    throw new Error("Scenario scale must be an integer from 1 to 100");
  }
  return names.map((name) => {
    const definition = definitions[name];
    return {
      name,
      scale,
      description: definition.description,
      issueCount: definition.issueCount + definition.scaleIssues * (scale - 1),
      eventCount: definition.eventCount + definition.scaleEvents * (scale - 1),
    };
  });
}

export function scenarioId(name: ScenarioName, kind: string, index = 0): string {
  return `${scenarioPrefix(name)}${kind.replace(/[^a-z0-9]/gi, "").toLowerCase()}${String(index).padStart(6, "0")}`;
}

export function scenarioPrefix(name: ScenarioName): string {
  return `cscenario${name.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
}

export function buildRelativeScenarioTimes(seedTime: Date) {
  const seedMs = seedTime.getTime();
  if (!Number.isFinite(seedMs)) throw new Error("Scenario seed time must be valid");
  const minute = 60_000;
  return {
    connectionLastSeenAt: new Date(seedMs),
    runStartedAt: new Date(seedMs - 240 * minute),
    runLastEventAt: [1, 10, 180, 30].map((minutes) => new Date(seedMs - minutes * minute)),
    invitationExpiresAt: new Date(seedMs + 30 * 24 * 60 * minute),
  };
}
