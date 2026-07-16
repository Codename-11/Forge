import "server-only";
import { z } from "zod";
import { promises as fs } from "node:fs";
import path from "node:path";
import { router, protectedProcedure } from "@/server/trpc";
import { forgeBuildIdentity } from "@/server/build-info";
import { parseChangelog, type ChangelogEntry } from "@/server/services/changelog-parser";

/**
 * System-wide read-only data — currently just the parsed CHANGELOG.md
 * for the dashboard's "What's New" rail. Stays workspace-procedure-
 * scoped so the proc requires authentication, even though the data
 * isn't tenant-specific (the changelog is the same for every
 * workspace).
 *
 * Caching: we keep a process-memory cache keyed off the file's mtime
 * so each container reads the file once per boot (and re-reads if it
 * changes on disk, e.g. a hot-reload during dev). No DB column.
 */

interface CachedChangelog {
  mtimeMs: number;
  entries: ChangelogEntry[];
  rawBody: string;
}

let _cache: CachedChangelog | null = null;
function changelogPath(): string {
  return path.join(process.cwd(), "CHANGELOG.md");
}

async function readChangelog(): Promise<CachedChangelog> {
  const file = changelogPath();
  let stat: { mtimeMs: number };
  try {
    stat = await fs.stat(file);
  } catch {
    // File missing — return empty payload but cache it so we don't
    // hammer the FS on every request.
    const empty: CachedChangelog = { mtimeMs: 0, entries: [], rawBody: "" };
    _cache = empty;
    return empty;
  }
  if (_cache && _cache.mtimeMs === stat.mtimeMs) return _cache;
  const raw = await fs.readFile(file, "utf8");
  const entries = parseChangelog(raw);
  _cache = { mtimeMs: stat.mtimeMs, entries, rawBody: raw };
  return _cache;
}

/**
 * Best-effort Keep-a-Changelog parser. Recognizes `## [version] —
 * tail` headings (with `—` or `-` separators) and `### Added` /
 * `### Changed` / `### Fixed` / `### Removed` subheadings whose
 * bullets become items. Unknown subsections are ignored. The full
 * raw section is preserved on the entry for the whats-new page to
 * render with markdown.
 */
export const systemRouter = router({
  changelog: protectedProcedure
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(20).default(5),
        })
        .default({ limit: 5 }),
    )
    .query(async ({ input }) => {
      const cache = await readChangelog();
      return {
        entries: cache.entries.slice(0, input.limit),
        total: cache.entries.length,
      };
    }),

  /** Full changelog body for the `/whats-new` page renderer. */
  changelogFull: protectedProcedure.query(async () => {
    const cache = await readChangelog();
    return { rawBody: cache.rawBody, entries: cache.entries };
  }),

  /**
   * Build identity — the precise "what's running" anchor for support + "is my
   * fix live?". `gitSha` + `buildTime` are baked at `docker compose build`
   * (deploy ritual); `release` is the latest curated CHANGELOG SemVer;
   * `version` is the package.json version.
   */
  buildInfo: protectedProcedure.query(async () => {
    const cache = await readChangelog();
    const build = await forgeBuildIdentity();
    return {
      ...build,
      release: cache.entries.find((e) => e.date)?.release ?? null,
    };
  }),
});

/** Test helper — drops the in-process cache. Not exported via tRPC. */
export function _resetChangelogCache(): void {
  _cache = null;
}
