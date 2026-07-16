export type ActivityUpdateCopy = {
  label: string;
  detail?: string | null;
  phase?: string;
};

const FIELD_LABELS: Record<string, string> = {
  title: "title",
  description: "description",
  priority: "priority",
  statusId: "status",
  projectId: "project",
  cycleId: "sprint",
  parentId: "parent issue",
  dueDate: "due date",
  estimate: "estimate",
  assigneeIds: "assignees",
  assignedAgentId: "assigned agent",
  verificationChecklist: "verification checklist",
  queued: "queue state",
};

function record(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
}

function titleCase(value: string): string {
  const text = humanize(value);
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Updated";
}

function safeScalar(value: unknown): string | null {
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!text || text.length > 100 || /^c[a-z0-9]{8,}$/i.test(text)) return null;
  return text;
}

/** Build compact evidence-backed copy for generic ISSUE_UPDATED events. */
export function issueUpdateCopy(payload: unknown): ActivityUpdateCopy | null {
  const data = record(payload);
  if (!data) return null;

  const action = typeof data.action === "string" ? data.action.trim() : "";
  if (action) {
    const branch = safeScalar(data.branch);
    const repository = safeScalar(data.repoFullName);
    return {
      label: titleCase(action),
      detail: [repository, branch].filter(Boolean).join(" · ") || null,
      phase: action.includes("work-session") ? "delivery" : "automation",
    };
  }

  const addCount = Array.isArray(data.add) ? data.add.length : 0;
  const removeCount = Array.isArray(data.remove) ? data.remove.length : 0;
  if (addCount > 0 || removeCount > 0) {
    const detail = [
      addCount > 0 ? `${addCount} added` : null,
      removeCount > 0 ? `${removeCount} removed` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return { label: "Labels changed", detail, phase: "labels" };
  }

  const fields = Object.keys(data)
    .filter((key) => key in FIELD_LABELS)
    .map((key) => ({ key, label: FIELD_LABELS[key]! }));
  if (fields.length === 0) return null;
  if (fields.length === 1) {
    const field = fields[0]!;
    const detail = ["title", "priority", "dueDate", "estimate", "queued"].includes(field.key)
      ? safeScalar(data[field.key])
      : null;
    return { label: `${titleCase(field.label)} updated`, detail, phase: field.label };
  }
  return {
    label: `Updated ${fields.map((field) => field.label).join(", ")}`,
    phase: "fields",
  };
}
