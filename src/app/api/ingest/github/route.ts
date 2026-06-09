import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/server/db";
import { handleGitHubWebhookRequest } from "@/server/services/github/webhook";

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  try {
    const result = await handleGitHubWebhookRequest({
      db,
      rawBody,
      signature: req.headers.get("x-hub-signature-256"),
      deliveryId: req.headers.get("x-github-delivery"),
      event: req.headers.get("x-github-event"),
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "GitHub webhook failed.";
    const status = message.includes("signature")
      ? 401
      : message.includes("Missing") || message.includes("valid JSON")
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
