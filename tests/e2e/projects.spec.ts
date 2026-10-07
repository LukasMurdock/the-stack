import { expect, test } from "@playwright/test";
import { createOrganization } from "./organizations";

test("project creation preserves the draft after failure and persists after retry", async ({
	page,
}) => {
	await createOrganization(page);
	await page.getByRole("link", { name: "Projects", exact: true }).click();
	await page.getByLabel("Project name").fill("Launch");
	await page.getByLabel("Description").fill("Plan the pilot.");
	await page.route("**/api/organizations/*/projects", (route) =>
		route.request().method() === "POST"
			? route.fulfill({
					status: 503,
					contentType: "text/plain",
					body: "Unavailable",
				})
			: route.continue()
	);
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(page.getByRole("alert")).toContainText("503");
	await expect(page.getByLabel("Project name")).toHaveValue("Launch");
	await page.unroute("**/api/organizations/*/projects");
	await page.getByLabel("Project name").fill("Launch pilot");
	await page
		.getByRole("button", { name: "Create project", exact: true })
		.click();
	await expect(
		page.getByRole("heading", { name: "Launch pilot", exact: true })
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByText("Plan the pilot.", { exact: true })
	).toBeVisible();
});
