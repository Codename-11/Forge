import { z } from "zod";
import { PluginScope } from "@prisma/client";

/**
 * Plugin manifest — the contract between Forge and a plugin.
 *
 * A plugin is either "delegated" (HTTP webhook; plugin server receives events
 * and calls Forge back with scoped API key) or "local" (Forge runs a
 * server-side handler registered under `plugins/<slug>/handler.ts`).
 *
 * Manifests are validated at registration time. The `scopes` array is the
 * ceiling for any API key issued to the plugin — requested scopes on a key
 * must be a subset of declared manifest scopes.
 */
export const skillSchema = z.object({
  name: z
    .string()
    .min(2)
    .max(64)
    .regex(/^[a-z][a-z0-9_.-]*$/, "Skill names are lowercase slug style."),
  description: z.string().max(500).optional(),
  /// Minimal JSON Schema — accepted as an opaque JSON object; runtime validates.
  inputSchema: z.record(z.unknown()),
  outputSchema: z.record(z.unknown()).optional(),
  runtime: z.enum(["plugin", "local"]),
});

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z
    .string()
    .min(2)
    .max(48)
    .regex(/^[a-z][a-z0-9-]*$/),
  name: z.string().min(1).max(80),
  description: z.string().max(1000).optional(),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/, "Use semver (1.0.0)."),
  author: z
    .object({
      name: z.string().max(80),
      url: z.string().url().optional(),
      email: z.string().email().optional(),
    })
    .optional(),
  scopes: z.array(z.nativeEnum(PluginScope)).min(1),
  events: z
    .array(
      z.enum([
        "ISSUE_CREATED",
        "ISSUE_UPDATED",
        "ISSUE_DELETED",
        "ISSUE_STATUS_CHANGED",
        "ISSUE_ASSIGNED",
        "ISSUE_PRIORITY_CHANGED",
        "COMMENT_CREATED",
        "COMMENT_UPDATED",
        "PROJECT_CREATED",
        "PROJECT_UPDATED",
      ]),
    )
    .default([]),
  skills: z.array(skillSchema).default([]),
  /// Rate-limit ceiling the plugin accepts (per-minute). Forge enforces.
  rateLimit: z
    .object({
      perMinute: z.number().int().min(1).max(10_000).default(120),
    })
    .default({ perMinute: 120 }),
});

export type PluginManifest = z.infer<typeof manifestSchema>;
