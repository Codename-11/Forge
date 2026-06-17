"use client";

import { useEffect, useState } from "react";
import { GITHUB_API_REPO } from "@/lib/repo";

/**
 * Live GitHub star count. Fetched client-side at runtime (the site is a static
 * export, so there is no request-time server fetch) from the public REST API —
 * no token, CORS-open, ~60 req/hr per IP unauthenticated.
 *
 * Designed to sit *inside* an existing repo link: it renders a leading dot
 * divider + a filled star + the formatted count, and renders nothing at all
 * while loading or if the fetch fails (so the surrounding link never shows a
 * broken or half-rendered badge). A 1-hour localStorage cache + a module-level
 * in-flight promise keep it to a single request across the nav/footer mounts
 * and across page navigations.
 */

const CACHE_KEY = "forge:gh-stars";
const TTL_MS = 60 * 60 * 1000; // 1 hour

let inflight: Promise<number | null> | null = null;

function readCache(): number | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const { v, t } = JSON.parse(raw) as { v: number; t: number };
    if (typeof v === "number" && typeof t === "number" && Date.now() - t < TTL_MS) return v;
  } catch {
    /* ignore malformed / unavailable storage */
  }
  return null;
}

function fetchStars(): Promise<number | null> {
  const cached = readCache();
  if (cached !== null) return Promise.resolve(cached);
  if (inflight) return inflight;
  inflight = fetch(GITHUB_API_REPO, { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((d: { stargazers_count?: number } | null) => {
      const n = d && typeof d.stargazers_count === "number" ? d.stargazers_count : null;
      if (n !== null) {
        try {
          localStorage.setItem(CACHE_KEY, JSON.stringify({ v: n, t: Date.now() }));
        } catch {
          /* ignore unavailable storage */
        }
      }
      return n;
    })
    .catch(() => null)
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** 0..999 → "0".."999"; 1000+ → "1.2k" / "12k". */
function fmt(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k >= 10 ? Math.round(k) : Number(k.toFixed(1))}k`;
}

export function GitHubStars({ size = 12 }: { size?: number }) {
  const [stars, setStars] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    fetchStars().then((n) => {
      if (active && n !== null) setStars(n);
    });
    return () => {
      active = false;
    };
  }, []);

  // Only surface the badge once the repo has traction: hidden while loading, on
  // error, and at 0 stars (a freshly public repo shouldn't advertise "★ 0").
  if (stars === null || stars < 1) return null;

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
      aria-label={`${stars} GitHub stars`}
    >
      <span aria-hidden style={{ opacity: 0.4 }}>·</span>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden style={{ display: "block" }}>
        <path d="M12 2.5l2.9 5.88 6.49.94-4.7 4.58 1.11 6.46L12 17.77 6.2 20.84l1.11-6.46-4.7-4.58 6.49-.94L12 2.5z" />
      </svg>
      <span>{fmt(stars)}</span>
    </span>
  );
}
