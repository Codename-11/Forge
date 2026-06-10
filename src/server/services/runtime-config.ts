import "server-only";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import { getRuntimeAdapter } from "@/server/runtimes/adapters";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
} from "@/server/services/dispatch/codex-app-server";
import { RUNTIME_TOOL_CAPABILITIES, type RuntimeToolCapability } from "@/lib/runtime-tools";

const runtimeToolCapabilitySchema = z.enum(RUNTIME_TOOL_CAPABILITIES);
const runtimeModeToolProfilesSchema = z
  .object({
    EXECUTE: z.array(runtimeToolCapabilitySchema).max(RUNTIME_TOOL_CAPABILITIES.length).optional(),
    RESEARCH: z.array(runtimeToolCapabilitySchema).max(RUNTIME_TOOL_CAPABILITIES.length).optional(),
    REVIEW: z.array(runtimeToolCapabilitySchema).max(RUNTIME_TOOL_CAPABILITIES.length).optional(),
    DISCUSS: z.array(runtimeToolCapabilitySchema).max(RUNTIME_TOOL_CAPABILITIES.length).optional(),
  })
  .strict();
const runtimeToolSurfaceShape = {
  localWorkspaceTools: z.boolean().optional(),
  toolCapabilities: z.array(runtimeToolCapabilitySchema).max(RUNTIME_TOOL_CAPABILITIES.length).optional(),
  workspaceRoot: z.string().max(500).optional(),
  modeToolPolicyEnforced: z.boolean().optional(),
  modeToolProfiles: runtimeModeToolProfilesSchema.optional(),
};

const optionalTextConfigSchema = (max = 160) => z.string().trim().max(max).optional();

type RuntimeToolSurfaceInput = {
  localWorkspaceTools?: boolean;
  toolCapabilities?: RuntimeToolCapability[];
  workspaceRoot?: string;
  modeToolPolicyEnforced?: boolean;
  modeToolProfiles?: Partial<Record<"EXECUTE" | "RESEARCH" | "REVIEW" | "DISCUSS", RuntimeToolCapability[]>>;
};

function cleanRuntimeToolSurface(input: RuntimeToolSurfaceInput): Prisma.JsonObject {
  const out: Prisma.JsonObject = {};
  if (input.localWorkspaceTools !== undefined) out.localWorkspaceTools = input.localWorkspaceTools;
  if (input.toolCapabilities !== undefined) {
    out.toolCapabilities = [...new Set(input.toolCapabilities)];
  }
  const workspaceRoot = input.workspaceRoot?.trim();
  if (workspaceRoot) out.workspaceRoot = workspaceRoot;
  if (input.modeToolPolicyEnforced !== undefined) {
    out.modeToolPolicyEnforced = input.modeToolPolicyEnforced;
  }
  const profiles = input.modeToolProfiles;
  if (profiles) {
    const cleaned: Prisma.JsonObject = {};
    for (const mode of ["EXECUTE", "RESEARCH", "REVIEW", "DISCUSS"] as const) {
      const allowed = [...new Set(profiles[mode] ?? [])].filter((tool): tool is RuntimeToolCapability =>
        (RUNTIME_TOOL_CAPABILITIES as readonly string[]).includes(tool),
      );
      if (allowed.length > 0 || mode !== "EXECUTE") cleaned[mode] = allowed;
    }
    if (Object.keys(cleaned).length > 0) out.modeToolProfiles = cleaned;
  }
  return out;
}

const codexConfigSchema = z
  .object({
    sandboxMode: z.enum(CODEX_SANDBOX_MODES as [string, ...string[]]).optional(),
    approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES as [string, ...string[]]).optional(),
    model: optionalTextConfigSchema(160),
    yoloMode: z.boolean().optional(),
    ...runtimeToolSurfaceShape,
  })
  .strict();

const hermesConfigSchema = z
  .object({
    profile: optionalTextConfigSchema(120),
    mode: optionalTextConfigSchema(80),
    model: optionalTextConfigSchema(160),
    yoloMode: z.boolean().optional(),
    ...runtimeToolSurfaceShape,
  })
  .strict();

function cleanOptionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export type RuntimeConfigStatus = {
  ok: boolean;
  code: "ok" | "no-adapter" | "unknown-adapter" | "config-mismatch";
  tone: "ok" | "warning" | "danger" | "muted";
  label: string;
  detail: string;
};

function hasConfigEntries(config: unknown): boolean {
  return !!(
    config &&
    typeof config === "object" &&
    !Array.isArray(config) &&
    Object.keys(config).length > 0
  );
}

function describeRuntimeConfigError(err: unknown): string {
  if (err instanceof z.ZodError) {
    return err.issues
      .slice(0, 4)
      .map((issue) => {
        const path = issue.path.length ? issue.path.join(".") : "config";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
  }
  if (err instanceof TRPCError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Config did not pass validation.";
}

export function validateRuntimeConfig(
  adapterKey: string | null | undefined,
  config: unknown,
): Prisma.InputJsonValue {
  if (adapterKey === "codex-app-server") {
    const parsed = codexConfigSchema.parse(config ?? {});
    return {
      ...(parsed.sandboxMode ? { sandboxMode: parsed.sandboxMode } : {}),
      ...(parsed.approvalPolicy ? { approvalPolicy: parsed.approvalPolicy } : {}),
      ...(cleanOptionalText(parsed.model) ? { model: cleanOptionalText(parsed.model) } : {}),
      ...(parsed.yoloMode !== undefined ? { yoloMode: parsed.yoloMode } : {}),
      ...cleanRuntimeToolSurface(parsed),
    } as Prisma.InputJsonValue;
  }
  if (adapterKey === "hermes") {
    const parsed = hermesConfigSchema.parse(config ?? {});
    return {
      ...(cleanOptionalText(parsed.profile) ? { profile: cleanOptionalText(parsed.profile) } : {}),
      ...(cleanOptionalText(parsed.mode) ? { mode: cleanOptionalText(parsed.mode) } : {}),
      ...(cleanOptionalText(parsed.model) ? { model: cleanOptionalText(parsed.model) } : {}),
      ...(parsed.yoloMode !== undefined ? { yoloMode: parsed.yoloMode } : {}),
      ...cleanRuntimeToolSurface(parsed),
    } as Prisma.InputJsonValue;
  }
  if (config && Object.keys(config as object).length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Adapter "${adapterKey ?? "unknown"}" takes no config.`,
    });
  }
  return {} as Prisma.InputJsonValue;
}

export function runtimeConfigStatus(
  adapterKey: string | null | undefined,
  config: unknown,
): RuntimeConfigStatus {
  if (!adapterKey) {
    return hasConfigEntries(config)
      ? {
          ok: false,
          code: "no-adapter",
          tone: "warning",
          label: "Legacy config",
          detail:
            "Runtime has stored config but no adapter key, so Forge cannot validate it against a current adapter schema.",
        }
      : {
          ok: true,
          code: "no-adapter",
          tone: "muted",
          label: "No adapter config",
          detail: "Runtime has no adapter key and no stored adapter config.",
        };
  }

  const adapter = getRuntimeAdapter(adapterKey);
  if (!adapter) {
    return {
      ok: false,
      code: "unknown-adapter",
      tone: "danger",
      label: "Unknown adapter",
      detail: `Runtime references adapter "${adapterKey}", which is not present in this Forge build.`,
    };
  }

  try {
    validateRuntimeConfig(adapterKey, config);
    return {
      ok: true,
      code: "ok",
      tone: "ok",
      label: "Config ok",
      detail: `Stored config matches the current ${adapter.title} adapter schema.`,
    };
  } catch (err) {
    return {
      ok: false,
      code: "config-mismatch",
      tone: "danger",
      label: "Config mismatch",
      detail: `Stored Runtime.config no longer matches the current ${adapter.title} adapter schema. ${describeRuntimeConfigError(err)} Re-save the runtime with current fields to normalize it.`,
    };
  }
}
