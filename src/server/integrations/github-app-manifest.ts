import "server-only";
import { Role, type PrismaClient } from "@prisma/client";
import { encryptSecret, decryptSecret } from "@/server/crypto";

/**
 * Shared helpers for the GitHub App **manifest flow** (no manual PEM paste):
 * Forge POSTs an app manifest to GitHub; GitHub creates the app and redirects
 * back with a `code` that we exchange for the app's credentials (including a
 * freshly-generated private key). See the routes under
 * `src/app/api/integrations/github-app/*` and
 * https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
 */

const STATE_TTL_MS = 15 * 60 * 1000;

export type ManifestState = {
  /** "create" = manifest conversion; "install" = post-install installation id. */
  purpose: "create" | "install";
  workspaceId: string;
  userId: string;
  /** Present for the install leg: the GithubApp row to stamp the install onto. */
  githubAppId?: string;
  /** Where to send the operator when the flow finishes. */
  returnTo: string;
  /** Expiry (epoch ms). */
  exp: number;
};

/** Opaque, tamper-proof, self-expiring state token (AES-256-GCM via AUTH_SECRET). */
export function signManifestState(payload: Omit<ManifestState, "exp">): string {
  const full: ManifestState = { ...payload, exp: Date.now() + STATE_TTL_MS };
  return encryptSecret(JSON.stringify(full));
}

export function verifyManifestState(token: string): ManifestState | null {
  try {
    const parsed = JSON.parse(decryptSecret(token)) as ManifestState;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** A safe in-app return path (defends the post-flow redirect). */
export function safeReturnTo(value: string | null | undefined, fallback: string): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.length > 400) {
    return fallback;
  }
  return value;
}

/** Confirm the user is an admin/owner of the workspace (mutations are gated). */
export async function isWorkspaceAdmin(
  db: PrismaClient,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const m = await db.membership.findFirst({
    where: { userId, workspaceId, role: { in: [Role.OWNER, Role.ADMIN] } },
    select: { id: true },
  });
  return !!m;
}

/**
 * The GitHub App manifest. Minimal permissions for git work (clone/push/PR) +
 * metadata. The same app also owns native issue/PR sync so operators do not
 * have to configure a second instance-level app. `redirect_url` receives the
 * conversion `code`; `setup_url` receives the post-install `installation_id`.
 */
export function buildManifest(opts: { origin: string; name: string }): Record<string, unknown> {
  return {
    name: opts.name,
    url: opts.origin,
    redirect_url: `${opts.origin}/api/integrations/github-app/callback`,
    setup_url: `${opts.origin}/api/integrations/github-app/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "read",
      checks: "write",
      statuses: "read",
      metadata: "read",
    },
    default_events: [
      "issues",
      "issue_comment",
      "pull_request",
      "pull_request_review",
      "check_suite",
      "check_run",
      "status",
    ],
    hook_attributes: { url: `${opts.origin}/api/ingest/github`, active: true },
  };
}
