import { NextResponse } from "next/server";
import { readUserAvatar } from "@/server/services/user-avatar";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ userId: string }> },
): Promise<Response> {
  const { userId } = await params;
  try {
    const avatar = await readUserAvatar(userId);
    if (!avatar) return unavailable();
    const etag = avatar.etag ? `"${avatar.etag}"` : null;
    if (etag && request.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers: cacheHeaders(etag) });
    }
    return new Response(avatar.bytes as BodyInit, {
      headers: {
        ...cacheHeaders(etag),
        "Content-Type": avatar.contentType,
        "Content-Length": String(avatar.bytes.byteLength),
        "Last-Modified": avatar.updatedAt.toUTCString(),
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch {
    return unavailable();
  }
}

function cacheHeaders(etag: string | null): Record<string, string> {
  return {
    "Cache-Control": "public, max-age=0, must-revalidate",
    ...(etag ? { ETag: etag } : {}),
    "Referrer-Policy": "no-referrer",
  };
}

function unavailable(): NextResponse {
  return NextResponse.json(
    { error: "Avatar unavailable." },
    {
      status: 404,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
