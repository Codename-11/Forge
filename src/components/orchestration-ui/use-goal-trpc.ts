"use client";
import { trpc } from "@/lib/trpc";

/**
 * Guarded accessors for the `goal.*` tRPC router.
 *
 * The orchestration backend agent ships `goal.create / list / get /
 * abandon` in parallel with this UI. Until the tRPC types regenerate at
 * merge, the `goal` namespace isn't on the typed proxy, so we reach it
 * through a single `unknown`-cast surface here rather than scattering
 * `as` casts across the pages. Each accessor returns `undefined` when
 * the procedure isn't present at runtime, letting callers degrade
 * gracefully (a "not available yet" empty state) instead of crashing.
 *
 * Schema contract (consumed shape):
 *   Goal { id, title, description?, status, issueId?, crewId?,
 *          maxTotalCostUsd?, maxWallTimeMinutes?, totalCostUsd,
 *          startedAt?, achievedAt? }
 */

type GoalRow = {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  issueId?: string | null;
  // Source issue embedded on `goal.get` — for the "From issue" backlink.
  issue?: { id: string; number: number; title: string } | null;
  crewId?: string | null;
  maxTotalCostUsd?: number | null;
  maxWallTimeMinutes?: number | null;
  totalCostUsd?: number | null;
  startedAt?: string | Date | null;
  achievedAt?: string | Date | null;
  createdAt?: string | Date | null;
  // The backend may embed plan/step rollups on get; kept loose.
  plans?: GoalPlanRow[];
  activePlan?: GoalPlanRow | null;
  // Crew roster embedded on `goal.get` (read-only display).
  crew?: GoalCrewRow | null;
  _count?: { plans?: number } | null;
};

type GoalCrewRow = {
  id: string;
  name: string;
  maxParallel?: number | null;
  members: {
    id: string;
    role: string;
    position?: number;
    agent: {
      id: string;
      name: string;
      profileKey: string;
      avatar?: string | null;
      status?: string | null;
      lastHeartbeatAt?: string | Date | null;
    };
  }[];
};

type GoalPlanRow = {
  id: string;
  title: string;
  status: string;
  isActiveAttempt?: boolean;
  totalCostUsd?: number | null;
  maxTotalCostUsd?: number | null;
  createdAt?: string | Date | null;
  updatedAt?: string | Date | null;
  steps?: {
    id: string;
    title?: string;
    status: string;
    assignedAgentId?: string | null;
    updatedAt?: string | Date | null;
    runs?: {
      id: string;
      status: "ACTIVE" | "COMPLETED" | "ABANDONED" | "STALLED" | "WAITING" | string;
      summary?: string | null;
      currentStep?: string | null;
      triggerKind?: string | null;
      externalRunId?: string | null;
      lastEventAt?: string | Date | null;
      lastWakeAt?: string | Date | null;
    }[];
  }[];
  _count?: { steps?: number } | null;
};

type QueryHook<TInput, TOutput> = {
  useQuery: (
    input: TInput,
    opts?: { enabled?: boolean; staleTime?: number },
  ) => { data: TOutput | undefined; isLoading: boolean };
};

type MutationHook<TInput, TOutput> = {
  useMutation: (opts?: {
    onSuccess?: (result: TOutput) => void;
    onError?: (e: { message: string }) => void;
  }) => { mutate: (input: TInput) => void; isPending: boolean };
};

type GoalPlannerInfo = {
  id: string;
  name: string;
  profileKey: string;
  status: string;
  runEngine: string | null;
  hasWebhook: boolean;
};

type GoalDecomposeResult = {
  planId: string;
  status: "PLANNING";
  plannerAgentId: string | null;
  planner: GoalPlannerInfo | null;
  dispatchable: boolean;
};

type GoalGenerateResult = {
  planId: string;
  status: "PLANNING";
  stepCount: number;
};

interface GoalRouter {
  list?: QueryHook<{ status?: string } | undefined, { items: GoalRow[] } | GoalRow[]>;
  get?: QueryHook<{ id: string }, GoalRow>;
  create?: MutationHook<
    {
      title: string;
      description?: string | null;
      issueId?: string;
      crewId?: string;
      maxTotalCostUsd?: number;
      maxWallTimeMinutes?: number;
    },
    { id: string }
  >;
  update?: MutationHook<
    {
      id: string;
      title?: string;
      description?: string | null;
      initiativeId?: string | null;
      crewId?: string | null;
      maxTotalCostUsd?: number | null;
      maxWallTimeMinutes?: number | null;
    },
    { id: string }
  >;
  decompose?: MutationHook<
    { goalId: string; plannerAgentId?: string | null; contextSetId?: string | null },
    GoalDecomposeResult
  >;
  generatePlan?: MutationHook<
    { goalId: string; contextSetId?: string | null },
    GoalGenerateResult
  >;
  abandon?: MutationHook<{ id: string }, { ok: boolean }>;
}

export function useGoalRouter(): GoalRouter | undefined {
  return (trpc as unknown as Record<string, unknown>).goal as
    | GoalRouter
    | undefined;
}

export type {
  GoalRow,
  GoalPlanRow,
  GoalCrewRow,
  GoalPlannerInfo,
  GoalDecomposeResult,
  GoalGenerateResult,
};
