export type ConsecutiveGroup<T> = {
  newest: T;
  oldest: T;
  count: number;
};

/**
 * Collapse only adjacent equivalent rows. This keeps audit order intact and
 * avoids merging distinct work that merely happens to share the same label.
 */
export function groupConsecutive<T>(
  items: readonly T[],
  keyFor: (item: T) => string,
): Array<ConsecutiveGroup<T>> {
  const groups: Array<ConsecutiveGroup<T>> = [];

  for (const item of items) {
    const previous = groups.at(-1);
    if (previous && keyFor(previous.newest) === keyFor(item)) {
      previous.oldest = item;
      previous.count += 1;
    } else {
      groups.push({ newest: item, oldest: item, count: 1 });
    }
  }

  return groups;
}
