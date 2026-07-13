export type QueueSummaryInput = {
  assignedAgent: unknown | null;
  unblocked: boolean;
};

export function canonicalIssueKey(workspaceKey: string, issueNumber: number): string {
  return `${workspaceKey.trim().toUpperCase()}-${issueNumber}`;
}

export function summarizeQueue(items: QueueSummaryInput[]): {
  total: number;
  unassigned: number;
  blocked: number;
} {
  return {
    total: items.length,
    unassigned: items.filter((item) => !item.assignedAgent).length,
    blocked: items.filter((item) => item.unblocked === false).length,
  };
}
