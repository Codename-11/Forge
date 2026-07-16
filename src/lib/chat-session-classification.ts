export const CHAT_SESSION_CLASSES = [
  "INTERACTIVE",
  "ISSUE",
  "BACKGROUND",
  "OTHER",
] as const;

export type ChatSessionClass = (typeof CHAT_SESSION_CLASSES)[number];
export type ChatSessionClassFilter = "all" | ChatSessionClass;

const CHAT_SESSION_CLASS_SET = new Set<string>(CHAT_SESSION_CLASSES);

const LABELS: Record<ChatSessionClass, string> = {
  INTERACTIVE: "Interactive chat",
  ISSUE: "Issue work",
  BACKGROUND: "Background",
  OTHER: "Other",
};

export const CHAT_SESSION_CLASS_FILTER_OPTIONS: ReadonlyArray<{
  value: ChatSessionClassFilter;
  label: string;
}> = [
  { value: "all", label: "All session types" },
  ...CHAT_SESSION_CLASSES.map((value) => ({ value, label: LABELS[value] })),
];

/** Unknown or historical classifications stay visible instead of breaking the drawer. */
export function normalizeChatSessionClass(value: unknown): ChatSessionClass {
  return typeof value === "string" && CHAT_SESSION_CLASS_SET.has(value)
    ? (value as ChatSessionClass)
    : "OTHER";
}

export function chatSessionClassLabel(value: unknown): string {
  return LABELS[normalizeChatSessionClass(value)];
}

export function chatSessionClassBadgeClass(value: unknown): string {
  switch (normalizeChatSessionClass(value)) {
    case "INTERACTIVE":
      return "border-ember/30 bg-ember/10 text-ember";
    case "ISSUE":
      return "border-sky-500/25 bg-sky-500/10 text-sky-600 dark:text-sky-400";
    case "BACKGROUND":
      return "border-warning/30 bg-warning/10 text-warning";
    case "OTHER":
      return "border-border bg-subtle/50 text-muted-foreground";
  }
}
