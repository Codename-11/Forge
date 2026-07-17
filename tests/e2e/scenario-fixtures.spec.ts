import { expect, test } from "@playwright/test";

test.describe("named local scenarios", () => {
  test.skip(process.env.FORGE_SCENARIOS !== "1", "requires the opt-in named scenario seed");

  test("renders deterministic large-workspace and delivery fixtures", async ({ page }) => {
    await page.goto("/w/forge/issues");
    await expect(
      page.getByRole("link", { name: /FRG-60000.*Scenario performance issue 0001/ }).first(),
    ).toBeVisible();

    await page.goto("/w/forge/issues/cscenariodeliverygithubissue000000");
    await expect(page.getByText("Scenario delivery open", { exact: true }).first()).toBeVisible();
    const delivery = page.getByRole("region", { name: "Code work coordination" });
    await expect(delivery.getByText("In review", { exact: true })).toBeVisible();
    await expect(page.getByText("implements", { exact: true })).toBeVisible();

    await page.goto("/w/forge/settings/members");
    await expect(page.getByText("scenario-invite-0@forge.local", { exact: true })).toBeVisible();
    await expect(
      page.getByText("scenario-invite-1@forge.local", { exact: true }).first(),
    ).toBeVisible();
    await expect(page.getByText("pending", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("accepted", { exact: true }).first()).toBeVisible();
  });
});
