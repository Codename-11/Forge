import { NextResponse } from "next/server";
import { db } from "@/server/db";
import { findPublishedArtifactByToken } from "@/server/services/artifact-studio";
import { presignDownloadUrl } from "@/server/services/storage";
import { rateLimit } from "@/server/rate-limit";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; attachmentId: string }> },
) {
  const { token, attachmentId } = await params;
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  if (!(await rateLimit(`artifact-share-asset:${ip}`, 120, 60)).ok) return unavailable();
  const publication = await findPublishedArtifactByToken(db, token);
  if (!publication) return unavailable();
  const version = await db.artifactVersion.findUnique({
    where: { id: publication.version.id },
    select: { assetManifest: true },
  });
  const allowed =
    Array.isArray(version?.assetManifest) &&
    version.assetManifest.some(
      (entry) =>
        typeof entry === "object" && entry !== null && "id" in entry && entry.id === attachmentId,
    );
  if (!allowed) return unavailable();
  const attachment = await db.attachment.findFirst({
    where: { id: attachmentId, workspaceId: publication.workspaceId },
    select: { kind: true, externalUrl: true, workspaceId: true, filename: true, mimeType: true },
  });
  if (!attachment) return unavailable();
  try {
    if (attachment.kind === "LINK" && attachment.externalUrl) {
      return NextResponse.redirect(attachment.externalUrl, {
        headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
      });
    }
    const signed = await presignDownloadUrl(attachmentId);
    const upstream = await fetch(signed.url, { signal: AbortSignal.timeout(15_000) });
    if (!upstream.ok || !upstream.body) return unavailable();
    return new Response(upstream.body, {
      headers: {
        "Content-Type": attachment.mimeType,
        "Content-Disposition": `inline; filename="${attachment.filename.replace(/["\\]/g, "")}"`,
        "Cache-Control": "private, no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return unavailable();
  }
}

function unavailable() {
  return NextResponse.json(
    { error: "Unavailable" },
    { status: 404, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } },
  );
}
