export interface ChangelogItem {
  type: "added" | "changed" | "fixed" | "removed";
  text: string;
}

export interface ChangelogEntry {
  /** Stable, release-unique identity used for persistence and React keys. */
  id: string;
  version: string;
  date: string | null;
  release: string | null;
  heading: string;
  items: ChangelogItem[];
  raw: string;
}

/** Parse the repository's Keep-a-Changelog release sections. */
export function parseChangelog(raw: string): ChangelogEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: ChangelogEntry[] = [];
  let cur: ChangelogEntry | null = null;
  let curRaw: string[] = [];
  let curSubtype: ChangelogItem["type"] | null = null;

  const flush = () => {
    if (cur) {
      cur.raw = curRaw.join("\n").trim();
      entries.push(cur);
    }
  };

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const heading = line.slice(3).trim();
      const bracketMatch = heading.match(/^\[([^\]]+)\](?:\s+[—-]\s+(.+))?$/);
      const plainMatch = bracketMatch ? null : heading.match(/^(.+?)(?:\s+[—-]\s+(.+))?$/);
      const version = (bracketMatch?.[1] ?? plainMatch?.[1])?.trim();
      if (!version) continue;
      flush();
      const tail = (bracketMatch?.[2] ?? plainMatch?.[2])?.trim() ?? "";
      const date = /^\d{4}-\d{2}-\d{2}$/.test(version) ? version : null;
      const release = tail.match(/\bv\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? null;
      const fullHeading = tail ? `${version} — ${tail}` : version;
      cur = {
        id: release ?? `${version}:${fullHeading}`,
        version,
        date,
        release,
        heading: fullHeading,
        items: [],
        raw: "",
      };
      curRaw = [];
      curSubtype = null;
      continue;
    }

    if (!cur) continue;
    curRaw.push(line);
    const subMatch = line.match(/^###\s+(Added|Changed|Fixed|Removed)\b/i);
    if (subMatch) {
      curSubtype = subMatch[1].toLowerCase() as ChangelogItem["type"];
      continue;
    }
    const bulletMatch = line.match(/^\s*-\s+(.+?)\s*$/);
    if (bulletMatch && curSubtype) {
      cur.items.push({
        type: curSubtype,
        text: bulletMatch[1].replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1"),
      });
    }
  }

  flush();
  return entries.filter((entry) => entry.version.toLowerCase() !== "unreleased");
}
