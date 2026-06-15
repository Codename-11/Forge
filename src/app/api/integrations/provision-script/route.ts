import { type NextRequest } from "next/server";
import { buildProvisionScript } from "@/server/integrations/provision-script";
import { publicOrigin } from "@/server/integrations/public-origin";

/**
 * Serves the canonical runtime provisioning script (see
 * `src/server/integrations/provision-script.ts`). The instance origin is baked
 * in as the default `FORGE_BASE_URL`, so a download is pre-pointed at this
 * Forge and the operator only needs to supply `FORGE_API_KEY`.
 *
 * Intentionally unauthenticated: the script contains NO secrets — it's a
 * generic tool, identical for everyone; the agent-linked API key is supplied by
 * the operator at run time. `?download=1` forces a file download.
 *
 *   curl -fsSL <origin>/api/integrations/provision-script -o forge-provision.cjs
 *   FORGE_API_KEY=forge_sk_... node forge-provision.cjs
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const script = buildProvisionScript(publicOrigin(req));
  const download = url.searchParams.get("download") === "1";
  return new Response(script, {
    headers: {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-store",
      ...(download
        ? { "content-disposition": 'attachment; filename="forge-provision.cjs"' }
        : {}),
    },
  });
}
