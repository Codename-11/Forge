import { test, expect } from "@playwright/test";

function createdThreadIdFromResponse(payload: unknown): string {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const threadId = (row as { result?: { data?: { json?: { thread?: { id?: unknown } } } } })?.result
    ?.data?.json?.thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("Expected chat.createConversation response to include thread.id");
  }
  return threadId;
}

/**
 * The first-class Chat surface renders its shell + composer when authenticated
 * (storageState from global-setup) against the seeded `forge` workspace.
 */
test("workspace Chat route renders the shell and composer", async ({ page }) => {
  await page.goto("/w/forge/chat");

  await expect(page.getByRole("button", { name: /new conversation/i })).toBeVisible();
  await expect(page.getByTestId("chat-composer")).toBeVisible();
});

test("collapsed conversation rail keeps recent chat history accessible", async ({ page }) => {
  const title = `E2E collapsed rail ${Date.now()}`;

  await page.goto("/w/forge/chat");
  await page.getByRole("button", { name: /new conversation/i }).click();

  const agentSelect = page.getByTestId("new-conversation-agent");
  const value = await agentSelect.locator("option", { hasText: "e2ebot" }).getAttribute("value");
  await agentSelect.selectOption(value!);
  await page.getByLabel(/^Title$/).fill(title);
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/trpc/chat.createConversation") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^create$/i }).click();
  const threadId = createdThreadIdFromResponse(await (await createResponse).json());
  await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));

  await page.getByRole("button", { name: /collapse conversations/i }).click();
  await expect(page.getByTestId("collapsed-conversation-rail")).toBeVisible();

  const collapsedThread = page.getByRole("button", { name: new RegExp(title) });
  await collapsedThread.hover();
  await expect(page.getByTestId("collapsed-chat-preview")).toContainText(title);
  await expect(page.getByTestId("collapsed-chat-preview")).toContainText("e2ebot");

  await page.getByRole("button", { name: /show conversations/i }).click();
  await expect(page.getByText(title).first()).toBeVisible();
});

test("/clear restores suggested prompts on an emptied conversation", async ({ page }) => {
  const title = `E2E clear suggestions ${Date.now()}`;

  await page.goto("/w/forge/chat");
  await page.getByRole("button", { name: /new conversation/i }).click();

  const agentSelect = page.getByTestId("new-conversation-agent");
  const value = await agentSelect.locator("option", { hasText: "e2ebot" }).getAttribute("value");
  await agentSelect.selectOption(value!);
  await page.getByLabel(/^Title$/).fill(title);
  const createResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/trpc/chat.createConversation") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /^create$/i }).click();
  const threadId = createdThreadIdFromResponse(await (await createResponse).json());
  await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));

  const suggestions = page.getByTestId("chat-suggested-prompts");
  await expect(suggestions).toBeVisible();

  const composerRoot = page.getByTestId("chat-composer");
  const composer = composerRoot.locator("textarea");
  const sendButton = composerRoot.getByRole("button", { name: "Send", exact: true });
  await composer.fill("hello before clear");
  await expect(composer).toHaveValue("hello before clear");
  await expect(sendButton).toBeEnabled();
  const streamResponse = page.waitForResponse(
    (response) =>
      response.url().includes("/api/chat/stream") && response.request().method() === "POST",
  );
  await sendButton.click();
  expect((await streamResponse).status()).toBe(200);
  await expect(
    page.getByTestId("chat-message-user").filter({ hasText: "hello before clear" }),
  ).toBeVisible();
  await expect(suggestions).toBeHidden();

  await composer.fill("/clear");
  const runCommandButton = composerRoot.getByRole("button", { name: "Run command", exact: true });
  await expect(runCommandButton).toBeEnabled();
  await runCommandButton.click();
  await expect(
    page.getByTestId("chat-message-system").filter({ hasText: /Conversation cleared/i }),
  ).toHaveCount(0);
  await expect(suggestions).toBeVisible();
});
