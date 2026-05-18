import { test, expect } from "@playwright/test";

/**
 * Opt-in authenticated smoke for the first-class Chat surface.
 *
 * Requires a seeded Forge session at FORGE_E2E_CHAT_URL or a base URL +
 * workspace slug. Backend/router tests cover data contracts unconditionally;
 * this checks route/nav/composer wiring when a prepared browser session exists:
 *
 *   FORGE_E2E_CHAT_SURFACE=1 FORGE_E2E_CHAT_URL=http://127.0.0.1:3002/w/axi/chat \
 *     pnpm exec playwright test tests/e2e/chat-surface.spec.ts
 */

test.skip(process.env.FORGE_E2E_CHAT_SURFACE !== "1", "requires seeded authenticated Forge UI");

test("workspace Chat route renders conversations and the attachment-capable composer", async ({ page }) => {
  const base = process.env.FORGE_E2E_BASE_URL ?? "http://127.0.0.1:3002";
  const slug = process.env.FORGE_E2E_WORKSPACE_SLUG ?? "axi";
  const url = process.env.FORGE_E2E_CHAT_URL ?? `${base}/w/${slug}/chat`;

  await page.goto(url, { waitUntil: "domcontentloaded" });

  await expect(page.getByText(/^Chat$/).first()).toBeVisible();
  await expect(page.getByText(/Conversations/i).first()).toBeVisible();
  await expect(page.getByTestId("chat-composer")).toBeVisible();
  await expect(page.getByRole("button", { name: /attach files/i })).toBeVisible();
});
