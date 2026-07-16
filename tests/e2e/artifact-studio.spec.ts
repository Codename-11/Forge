import { expect, test } from "@playwright/test";

test("artifact studio drafts, reviews, compares, comments, and shares a pinned version", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const title = `Artifact Studio ${Date.now()}`;
  await page.goto("/w/forge/settings/artifacts");
  const saveSettings = page.getByRole("button", { name: "Save artifact settings" });
  await expect(saveSettings).toBeEnabled();
  const externalSharing = page.getByLabel("Enable expiring external share links");
  if (!(await externalSharing.isChecked())) await externalSharing.check();
  await saveSettings.click();
  await expect(page.getByText("Artifact settings saved.")).toBeVisible();

  await page.goto("/w/forge/artifacts");
  await page.getByRole("button", { name: "New artifact" }).click();
  await page.getByPlaceholder("Artifact title").fill(title);
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible();

  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator("textarea").first().fill(
    "# Release decision\n\nShip the Artifact Studio control plane.",
  );
  await page.getByPlaceholder(/changelog/i).fill("Add release decision");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: /^v2\b/ })).toBeVisible();

  await page.getByRole("button", { name: "Request review" }).click();
  await expect(page.getByRole("button", { name: "Accept current version" })).toBeVisible();
  await page.getByRole("button", { name: "Accept current version" }).click();
  await expect(page.getByRole("button", { name: "Create expiring share link" })).toBeVisible();

  await page.getByPlaceholder("Comment on this artifact…").fill("Approved for the release notes.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Approved for the release notes.")).toBeVisible();

  await page.getByLabel("Compare from version").selectOption({ label: "v1" });
  await page.getByLabel("Compare to version").selectOption({ label: "v2" });
  await expect(page.getByText("Comparing v1 → v2")).toBeVisible();

  await page.getByRole("button", { name: "Create expiring share link" }).click();
  await expect(page.getByText(/Share link (copied|created)/)).toBeVisible();
});
