"use client";

import { useEffect, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";

const sections = {
  activity: "issue-activity",
  attachments: "issue-attachments",
  relations: "issue-relations",
} as const;

function focusSection(section: keyof typeof sections) {
  const target = document.getElementById(sections[section]);
  if (!target) return;
  target.scrollIntoView({ block: "start", behavior: "auto" });
  target.focus({ preventScroll: true });
}

/** Visible context sections replace tab-only content. Old links and shortcuts still work. */
export function IssueRail({
  issueId,
  header,
  children,
}: {
  issueId: string;
  header?: ReactNode;
  children?: ReactNode;
}) {
  const search = useSearchParams();
  const legacyTab = search?.get("tab");
  useEffect(() => {
    if (!legacyTab || !(legacyTab in sections)) return;
    const frame = requestAnimationFrame(() => focusSection(legacyTab as keyof typeof sections));
    return () => cancelAnimationFrame(frame);
  }, [issueId, legacyTab]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        target?.matches("input, textarea, select") ||
        target?.isContentEditable ||
        target?.closest(
          '[role="dialog"], [role="alertdialog"], [role="combobox"], [role="listbox"]',
        )
      )
        return;
      const section = ({ "1": "activity", "2": "attachments", "3": "relations" } as const)[
        event.key as "1" | "2" | "3"
      ];
      if (!section) return;
      event.preventDefault();
      focusSection(section);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <div className="space-y-4">
      {header}
      {children}
    </div>
  );
}
