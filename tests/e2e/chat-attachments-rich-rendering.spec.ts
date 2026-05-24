import { test, expect } from "@playwright/test";

/**
 * Chat composer accepts a file via the picker and shows it as a draft chip
 * before send. Authenticated via global-setup storageState; the full
 * upload→finalize→inline-render round-trip is covered by the attachments
 * integration tests, so this stays focused on the composer interaction.
 */
test("chat composer shows a picked file as a draft attachment", async ({ page }) => {
  await page.goto("/w/forge/chat");

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

  await expect(page.getByTestId("chat-attachment-drafts")).toContainText(
    "forge-chat-attachment.txt",
  );
});
