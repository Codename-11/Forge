import { expect, test } from "@playwright/test";

function createdThreadIdFromResponse(payload: unknown): string {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const threadId = (row as { result?: { data?: { json?: { thread?: { id?: unknown } } } } })
    ?.result?.data?.json?.thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("Expected chat.createConversation response to include thread.id");
  }
  return threadId;
}

test.describe("Chat action controls", () => {
  test("context chips, edit, regenerate, and fork work in a real chat thread", async ({
    page,
  }) => {
    const title = `E2E actions ${Date.now()}`;
    const forkTitle = `Fork: ${title}`;

    await page.goto("/w/forge/chat");

    await page.getByRole("button", { name: /new conversation/i }).click();
    const agentSelect = page.getByTestId("new-conversation-agent");
    await expect(agentSelect).toBeVisible();
    const value = await agentSelect
      .locator("option", { hasText: "e2ebot" })
      .getAttribute("value");
    await agentSelect.selectOption(value!);
    await page.getByLabel(/^Title$/).fill(title);
    const createResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/trpc/chat.createConversation") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: /^create$/i }).click();
    const originalThreadId = createdThreadIdFromResponse(await (await createResponse).json());
    await expect(page).toHaveURL(new RegExp(`thread=${originalThreadId}`));

    const composer = page.getByTestId("chat-composer");
    await expect(composer).toBeVisible();

    const contextToggle = composer.getByRole("button", { name: /context to send/i });
    await expect(contextToggle).toContainText("2/2 page items");
    await contextToggle.click();
    await expect(composer.getByRole("button", { name: /route:\/w\/forge\/chat/i })).toBeVisible();
    await composer.getByRole("button", { name: /workspace:forge/i }).click();
    await expect(contextToggle).toContainText("1/2 page items");

    const textbox = composer.getByRole("textbox").first();
    await textbox.fill("ping");
    await textbox.press("Enter");

    await expect(
      page.getByTestId("chat-message-user").filter({ hasText: "ping" }).first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("chat-message-agent").filter({ hasText: /E2E mock reply: pong/i }).first(),
    ).toBeVisible({ timeout: 25_000 });

    await page.getByTestId("chat-message-action-edit").first().click();
    await expect(textbox).toHaveValue("ping");
    await textbox.fill("");

    const agentRepliesBefore = await page
      .getByTestId("chat-message-agent")
      .filter({ hasText: /E2E mock reply: pong/i })
      .count();
    await page.getByTestId("chat-message-action-regenerate").last().click();
    await expect
      .poll(async () =>
        page.getByTestId("chat-message-agent").filter({ hasText: /E2E mock reply: pong/i }).count(),
      )
      .toBeGreaterThan(agentRepliesBefore);

    await page.getByTestId("chat-message-action-fork").last().click();
    await expect.poll(() => new URL(page.url()).searchParams.get("thread")).not.toBe(
      originalThreadId,
    );
    await expect(page.getByText(forkTitle).first()).toBeVisible({ timeout: 15_000 });
    await expect(
      page.getByTestId("chat-message-user").filter({ hasText: "ping" }).first(),
    ).toBeVisible();
    await expect(
      page.getByTestId("chat-message-agent").filter({ hasText: /E2E mock reply: pong/i }).first(),
    ).toBeVisible();
  });
});
