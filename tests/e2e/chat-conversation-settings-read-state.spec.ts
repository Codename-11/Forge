import { expect, test } from "@playwright/test";

const readStateKey = "forge.chat.lastSeen.forge";

function createdThreadIdFromResponse(payload: unknown): string {
  const row = Array.isArray(payload) ? payload[0] : payload;
  const threadId = (row as { result?: { data?: { json?: { thread?: { id?: unknown } } } } })
    ?.result?.data?.json?.thread?.id;
  if (typeof threadId !== "string") {
    throw new Error("Expected chat.createConversation response to include thread.id");
  }
  return threadId;
}

test.describe("Chat conversation settings and read state", () => {
  test.describe.configure({ mode: "serial" });

  test("renames a conversation and persists context policy", async ({ page }) => {
    const title = `E2E settings ${Date.now()}`;
    const renamed = `${title} renamed`;

    await page.goto("/w/forge/chat");
    await page.getByRole("button", { name: /new conversation/i }).click();

    const agentSelect = page.getByTestId("new-conversation-agent");
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
    const threadId = createdThreadIdFromResponse(await (await createResponse).json());
    await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));

    await expect(page.getByRole("button", { name: /^conversation$/i })).toBeVisible();
    await page.getByRole("button", { name: /^conversation$/i }).click();

    const modal = page.getByTestId("conversation-settings-modal");
    await expect(modal).toBeVisible();
    await modal.getByRole("textbox", { name: /^Title$/ }).fill(renamed);
    await modal.getByRole("textbox", { name: /^Topic$/ }).fill("Pinned test topic");
    await modal.getByRole("combobox", { name: /^Context mode$/ }).selectOption("FULL_SUMMARY");
    await modal.getByRole("button", { name: /save settings/i }).click();

    await expect(modal).toBeHidden();
    await expect(page.getByText(renamed).first()).toBeVisible();

    await page.getByRole("button", { name: /^conversation$/i }).click();
    await expect(modal.getByRole("textbox", { name: /^Title$/ })).toHaveValue(renamed);
    await expect(modal.getByRole("textbox", { name: /^Topic$/ })).toHaveValue(
      "Pinned test topic",
    );
    await expect(modal.getByRole("combobox", { name: /^Context mode$/ })).toHaveValue(
      "FULL_SUMMARY",
    );
  });

  test("viewing a thread marks it read in Chat and Mission Control", async ({ page }) => {
    const title = `E2E read ${Date.now()}`;

    await page.goto("/w/forge/chat");
    await page.getByRole("button", { name: /new conversation/i }).click();

    const agentSelect = page.getByTestId("new-conversation-agent");
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
    const threadId = createdThreadIdFromResponse(await (await createResponse).json());
    await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));

    await page.evaluate(
      ([key, id]) => {
        localStorage.setItem(key, JSON.stringify({ [id]: 0 }));
      },
      [readStateKey, threadId],
    );

    await page.goto(`/w/forge/chat?thread=${threadId}`);
    await expect
      .poll(async () =>
        page.evaluate(
          ([key, id]) => {
            const raw = localStorage.getItem(key);
            return raw ? (JSON.parse(raw)[id] as number | undefined) ?? 0 : 0;
          },
          [readStateKey, threadId],
        ),
      )
      .toBeGreaterThan(0);

    await page.evaluate(
      ([key, id]) => {
        localStorage.setItem(key, JSON.stringify({ [id]: 0 }));
      },
      [readStateKey, threadId],
    );
    await page.goto("/w/forge/dashboard");
    await page.getByTestId("mission-control-pill-chat").click();
    await expect(page.getByLabel("Search Mission Control chats")).toBeVisible();
    await page.getByRole("button", { name: new RegExp(title) }).click();

    await expect
      .poll(async () =>
        page.evaluate(
          ([key, id]) => {
            const raw = localStorage.getItem(key);
            return raw ? (JSON.parse(raw)[id] as number | undefined) ?? 0 : 0;
          },
          [readStateKey, threadId],
        ),
      )
      .toBeGreaterThan(0);
  });

  test("viewing chat activity marks the thread read", async ({ page }) => {
    const title = `E2E activity read ${Date.now()}`;

    await page.goto("/w/forge/chat");
    await page.getByRole("button", { name: /new conversation/i }).click();

    const agentSelect = page.getByTestId("new-conversation-agent");
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
    const threadId = createdThreadIdFromResponse(await (await createResponse).json());
    await expect(page).toHaveURL(new RegExp(`thread=${threadId}`));

    const composer = page.getByTestId("chat-composer");
    await composer.getByRole("textbox").first().fill("activity read marker");
    await composer.getByRole("textbox").first().press("Enter");
    await expect(page.getByText(/E2E mock reply: pong/i).first()).toBeVisible({
      timeout: 25_000,
    });

    await page.evaluate(
      ([key, id]) => {
        localStorage.setItem(key, JSON.stringify({ [id]: 0 }));
      },
      [readStateKey, threadId],
    );

    await page.goto("/w/forge/inbox");
    await page.getByRole("button", { name: /unread item|unread items|no unread items/i }).click();
    await page.getByRole("button", { name: /^Activity$/ }).click();
    await expect(page.getByText(/replied in chat|messaged/i).first()).toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(
          ([key, id]) => {
            const raw = localStorage.getItem(key);
            return raw ? (JSON.parse(raw)[id] as number | undefined) ?? 0 : 0;
          },
          [readStateKey, threadId],
        ),
      )
      .toBeGreaterThan(0);
  });
});
