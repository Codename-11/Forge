import "server-only";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma } from "@prisma/client";
import {
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
} from "@/server/services/dispatch/codex-app-server";
import { RUNTIME_TOOL_CAPABILITIES, type RuntimeToolCapability } from "@/lib/runtime-tools";

const runtimeToolCapabilitySchema = z.enum(RUNTIME_TOOL_CAPABILITIES);
const runtimeToolSurfaceShape = {
  localWorkspaceTools: z.boolean().optional(),
  toolCapabilities: z.array(runtimeToolCapabilitySchema).max(RUNTIME_TOOL_CAPABILITIES.length).optional(),
  workspaceRoot: z.string().max(500).optional(),
};

type RuntimeToolSurfaceInput = {
  localWorkspaceTools?: boolean;
  toolCapabilities?: RuntimeToolCapability[];
  workspaceRoot?: string;
};

function cleanRuntimeToolSurface(input: RuntimeToolSurfaceInput): Prisma.JsonObject {
  const out: Prisma.JsonObject = {};
  if (input.localWorkspaceTools) out.localWorkspaceTools = true;
  const tools = [...new Set(input.toolCapabilities ?? [])];
  if (tools.length > 0) out.toolCapabilities = tools;
  const workspaceRoot = input.workspaceRoot?.trim();
  if (workspaceRoot) out.workspaceRoot = workspaceRoot;
  return out;
}

const codexConfigSchema = z
  .object({
    sandboxMode: z.enum(CODEX_SANDBOX_MODES as [string, ...string[]]).optional(),
    approvalPolicy: z.enum(CODEX_APPROVAL_POLICIES as [string, ...string[]]).optional(),
    ...runtimeToolSurfaceShape,
  })
  .strict();

const hermesConfigSchema = z.object(runtimeToolSurfaceShape).strict();

export function validateRuntimeConfig(
  adapterKey: string | null | undefined,
  config: unknown,
): Prisma.InputJsonValue {
  if (adapterKey === "codex-app-server") {
    const parsed = codexConfigSchema.parse(config ?? {});
    return {
      ...(parsed.sandboxMode ? { sandboxMode: parsed.sandboxMode } : {}),
      ...(parsed.approvalPolicy ? { approvalPolicy: parsed.approvalPolicy } : {}),
      ...cleanRuntimeToolSurface(parsed),
    } as Prisma.InputJsonValue;
  }
  if (adapterKey === "hermes") {
    return cleanRuntimeToolSurface(
      hermesConfigSchema.parse(config ?? {}),
    ) as Prisma.InputJsonValue;
  }
  if (config && Object.keys(config as object).length > 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Adapter "${adapterKey ?? "unknown"}" takes no config.`,
    });
  }
  return {} as Prisma.InputJsonValue;
}

