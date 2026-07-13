import { test, expect } from "@playwright/test";

/**
 * Agent E2E over the in-process mock-runs connector (FORGE_E2E only): create a
 * conversation with the seeded "E2E Bot" (RUNS engine → mock connector) and
 * confirm its scripted reply streams into the thread. Exercises the full
 * chat → runs → SSE → render path with no external runtime or auth.
 */
test.describe("Chat runs streaming", () => {
  test("streams the mock agent's reply into the thread", async ({ page }) => {
    await page.goto("/w/forge/chat");

    await page.getByRole("button", { name: /new conversation/i }).click();
    const agentSelect = page.getByTestId("new-conversation-agent");
    await expect(agentSelect).toBeVisible();
    // Resolve the E2E Bot's option value (avoids matching the "·" label).
    const value = await agentSelect.locator("option", { hasText: "e2ebot" }).getAttribute("value");
    await agentSelect.selectOption(value!);
    await page.getByRole("button", { name: /^create$/i }).click();

    const composer = page.getByTestId("chat-composer");
    await expect(composer).toBeVisible();
    const textbox = composer.getByRole("combobox").first();
    await textbox.fill("ping");
    await textbox.press("Enter"); // Enter (no shift) submits — chat-composer.tsx

    // Text shows in the bubble + sidebar preview + hover tooltip; assert one.
    await expect(page.getByText(/E2E mock reply: pong/i).first()).toBeVisible({
      timeout: 25_000,
    });
  });
});
