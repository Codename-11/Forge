/**
 * Hash a workspace key to a deterministic HSL color within the warm-earthy
 * palette. Used by the workspace switcher badge and any workspace pills.
 *
 * Hue is restricted to warm earth tones (0–60° plus 25–45° emphasis +
 * 150–200° cool accent slice for visual distinction between many keys).
 * Saturation + lightness are pinned so the result always reads muted —
 * never neon, never pure — honoring the Forge warm-earthy aesthetic.
 */
export function workspaceColor(key: string): { bg: string; fg: string; ring: string } {
  const hue = hashHue(key);
  // Pinned tones — matches the "warm paper" palette in globals.css.
  const sat = 42;
  const light = 46;
  return {
    bg: `hsl(${hue} ${sat}% ${light}% / 0.18)`,
    fg: `hsl(${hue} ${sat + 10}% ${Math.max(light - 10, 26)}%)`,
    ring: `hsl(${hue} ${sat}% ${light}% / 0.45)`,
  };
}

function hashHue(key: string): number {
  // FNV-1a-lite; deterministic across runtimes.
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  // Warm palette slice: primary 15–55 (amber/rust/ochre), plus a cool
  // sliver 170–200 (slate/teal) so many keys remain distinguishable.
  const pick = Math.abs(h) % 100;
  if (pick < 75) {
    return 15 + (Math.abs(h >> 5) % 40); // 15..55
  }
  return 170 + (Math.abs(h >> 7) % 30); // 170..200
}
