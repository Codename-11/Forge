import "server-only";
import { db } from "@/server/db";
import { decryptSecret } from "@/server/crypto";
import { getInstallationTokenForApp } from "@/server/services/github-app";
import { getInstallationAccessToken } from "@/server/services/github/app-auth";

/**
 * Resolve an installation access token for a GitHub *Connection* installation.
 *
 * Forge has two GitHub-App credential sources that used to be disjoint:
 *   - the **global env app** (`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`), used
 *     by the connection/linking client (`app-auth.ts`), and
 *   - per-workspace **`GithubApp`** rows (their own PEM, encrypted at rest),
 *     set up via Settings → GitHub Apps and used for runtime `GH_TOKEN`.
 *
 * That split meant a workspace could have a working `GithubApp` ("Test
 * connection" green) yet still be unable to link PRs, because linking only
 * ever spoke to the env app. This resolver unifies them: if a `GithubApp` owns
 * the installation we're talking to, mint with *its* key; otherwise fall back
 * to the global env app. So configuring one `GithubApp` is enough for both
 * runtime auth and issue/PR linking — no separate env app required.
 */
export async function resolveInstallationToken(
  installationId: string | number,
  githubAppId?: string | null,
): Promise<string> {
  const key = String(installationId);
  const app = await db.githubApp.findFirst({
    where: githubAppId ? { id: githubAppId, installationId: key } : { installationId: key },
    select: { id: true, appId: true, installationId: true, privateKeyEnc: true },
  });
  if (app?.installationId) {
    const minted = await getInstallationTokenForApp(app.id, {
      appId: app.appId,
      installationId: app.installationId,
      privateKeyPem: decryptSecret(app.privateKeyEnc),
    });
    return minted.token;
  }
  if (githubAppId) {
    throw new Error("The authorized GitHub App no longer owns this installation.");
  }
  // No GithubApp owns this installation — use the global env app (legacy path).
  return getInstallationAccessToken(installationId);
}
