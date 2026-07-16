import { describe, expect, it } from "vitest";
import {
  CHAT_SESSION_CLASS_FILTER_OPTIONS,
  chatSessionClassBadgeClass,
  chatSessionClassLabel,
  normalizeChatSessionClass,
} from "@/lib/chat-session-classification";

describe("chat session classification", () => {
  it("provides stable operator-facing labels for every filter value", () => {
    expect(CHAT_SESSION_CLASS_FILTER_OPTIONS).toEqual([
      { value: "all", label: "All session types" },
      { value: "INTERACTIVE", label: "Interactive chat" },
      { value: "ISSUE", label: "Issue work" },
      { value: "BACKGROUND", label: "Background" },
      { value: "OTHER", label: "Other" },
    ]);
  });

  it("degrades unknown and historical values to Other", () => {
    expect(normalizeChatSessionClass("future-kind")).toBe("OTHER");
    expect(normalizeChatSessionClass(null)).toBe("OTHER");
    expect(chatSessionClassLabel(undefined)).toBe("Other");
  });

  it("uses token-backed badge styles for every classification", () => {
    for (const value of ["INTERACTIVE", "ISSUE", "BACKGROUND", "OTHER"] as const) {
      expect(chatSessionClassBadgeClass(value)).toMatch(/border-/);
      expect(chatSessionClassBadgeClass(value)).not.toMatch(/#[0-9a-f]/i);
    }
  });
});
