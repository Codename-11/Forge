import { redirect } from "next/navigation";

/**
 * Agent client inventory now lives with credential lifecycle in Agent access.
 * Keep this legacy account-level route working for saved links.
 */
export default function AgentClientsRedirect() {
  redirect("/settings/access");
}
