import { test, expect } from "@playwright/test";

/**
 * Browser-level coverage for Chat Attachments v1.
 *
 * The spec expects a seeded/dev workspace with an open Mission Control chat
 * panel. It is opt-in because CI/dev boxes differ in auth setup; backend
 * integration tests cover the server contract unconditionally, while this
 * catches composer regressions when run against a prepared browser session:
 *
 *   FORGE_E2E_CHAT_ATTACHMENTS=1 pnpm exec playwright test tests/e2e/chat-attachments-rich-rendering.spec.ts
 */

test.skip(process.env.FORGE_E2E_CHAT_ATTACHMENTS !== "1", "requires seeded authenticated Forge UI");

test("chat composer accepts file picker uploads and renders message attachments inline", async ({ page }) => {
  const base = process.env.FORGE_E2E_BASE_URL ?? "http://127.0.0.1:3002";
  const url = process.env.FORGE_E2E_CHAT_URL ?? `${base}/`;
  await page.goto(url);

  const composer = page.getByTestId("chat-composer");
  await expect(composer).toBeVisible();

  const chooserPromise = page.waitForEvent("filechooser");
  await composer.getByRole("button", { name: /attach files/i }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "forge-chat-attachment.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("hello from playwright"),
  });

  await expect(page.getByTestId("chat-attachment-drafts")).toContainText("forge-chat-attachment.txt");
  await composer.getByRole("textbox").fill("Attachment e2e smoke");
  await composer.getByRole("button", { name: /send/i }).click();

  await expect(page.getByText("Attachment e2e smoke")).toBeVisible();
  await expect(page.getByTestId("chat-message-attachments").last()).toContainText("forge-chat-attachment.txt");
});
