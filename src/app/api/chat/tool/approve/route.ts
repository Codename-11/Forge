import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/server/auth";
import { pendingApprovals } from "@/server/services/chat-stream-state";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ApproveBody {
  callId: string;
  approved: boolean;
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: ApproveBody;
  try {
    body = (await req.json()) as ApproveBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const callId = String(body.callId ?? "").trim();
  if (!callId) {
    return NextResponse.json({ error: "callId required" }, { status: 400 });
  }
  const approved = body.approved === true;

  const resolver = pendingApprovals.get(callId);
  if (!resolver) {
    return NextResponse.json(
      { ok: false, reason: "No pending approval for that callId." },
      { status: 404 },
    );
  }
  pendingApprovals.delete(callId);
  resolver({ approved });
  return NextResponse.json({ ok: true, approved });
}
