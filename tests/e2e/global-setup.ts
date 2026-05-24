import { chromium, type FullConfig } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Sign in once as the seeded owner (credentials provider keyed off
 * ADMIN_EMAIL/ADMIN_PASSWORD, which `scripts/e2e-web.sh` sets to the seed's
 * owner) and persist the JWT session as a storageState the whole suite reuses.
 * Replaces the old "sign-in handled out-of-band" hand-wave.
 */
const STORAGE = "tests/e2e/.auth/owner.json";

export default async function globalSetup(config: FullConfig) {
  const baseURL =
    config.projects[0]?.use?.baseURL ??
    process.env.PLAYWRIGHT_BASE_URL ??
    "http://localhost:3200";
  const email = process.env.ADMIN_EMAIL ?? "owner@forge.local";
  const password = process.env.ADMIN_PASSWORD ?? "forge-dev";

  mkdirSync(dirname(STORAGE), { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  try {
    await page.goto("/signin", { waitUntil: "domcontentloaded" });
    await page.fill('input[name="email"]', email);
    await page.fill('input[name="password"]', password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.startsWith("/signin"), { timeout: 30_000 }),
      page.getByRole("button", { name: /sign in/i }).click(),
    ]);
    // Land on an authenticated app route to confirm the session is live.
    await page.goto("/w/forge/inbox", { waitUntil: "domcontentloaded" });
    await page.context().storageState({ path: STORAGE });
  } finally {
    await browser.close();
  }
}
