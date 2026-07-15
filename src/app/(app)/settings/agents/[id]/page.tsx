import { redirect } from "next/navigation";

/**
 * Compatibility route for former Agent Studio detail links. Mission Control
 * now owns the canonical profile detail at `/agents/[id]`.
 */
export default async function AgentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/agents/${id}`);
}
