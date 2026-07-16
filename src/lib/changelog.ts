export function hasUnseenChangelog(
  latest: { id: string; release: string | null; date: string | null } | null,
  seenRelease: string | null,
  seenAt: string | Date | null,
): boolean {
  if (!latest) return false;
  if (latest.release) return latest.id !== seenRelease;
  return !!latest.date && (!seenAt || new Date(latest.date) > new Date(seenAt));
}
