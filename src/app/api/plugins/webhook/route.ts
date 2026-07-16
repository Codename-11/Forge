import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db";
import { verifyWebhookSignature } from "@/server/services/plugin-runtime";

/**
 * Inbound webhook endpoint — plugins POST signed events back to Forge
 * (e.g. a remote triage worker reporting completion). We verify the HMAC
 * signature using the plugin secret on file.
 */
export async function POST(req: NextRequest) {
  const slug = req.headers.get("x-forge-plugin");
  const workspaceRef = req.headers.get("x-forge-workspace");
  const ts = req.headers.get("x-forge-timestamp");
  const sig = req.headers.get("x-forge-signature");
  if (!slug || !ts || !sig) {
    return NextResponse.json({ error: "Missing signing headers." }, { status: 400 });
  }

  const candidates = await db.plugin.findMany({
    where: {
      slug,
      status: "APPROVED",
      ...(workspaceRef
        ? {
            workspace: {
              OR: [{ id: workspaceRef }, { slug: workspaceRef }, { key: workspaceRef }],
            },
          }
        : {}),
    },
    take: 2,
  });
  if (candidates.length > 1) {
    return NextResponse.json(
      { error: "Ambiguous plugin. Send x-forge-workspace with the workspace id, slug, or key." },
      { status: 409 },
    );
  }
  const plugin = candidates[0];
  if (!plugin?.secret) return NextResponse.json({ error: "Unknown plugin." }, { status: 404 });

  const body = await req.text();
  if (!verifyWebhookSignature(plugin.secret, ts, body, sig)) {
    return NextResponse.json({ error: "Bad signature." }, { status: 401 });
  }

  // Route based on body.type — keep this small and explicit.
  const parsed = JSON.parse(body) as { type?: string; data?: unknown };
  // TODO: dispatch plugin-originated events into a durable queue.
  return NextResponse.json({ received: true, type: parsed.type });
}
