import { expect, test } from "@playwright/test";
import { joinedViewer } from "./organizations";

test("member changes refresh role controls and revoke organization access", async ({
	page,
	browser,
}) => {
	const context = await browser.newContext();
	try {
		const viewer = await joinedViewer(page, context);
		// Acceptance happened in another browser context; refresh the owner's list.
		await page.reload();
		const role = page.getByLabel("Role for viewer", { exact: true });
		await role.selectOption("editor");
		await expect(role).toHaveValue("editor");
		await viewer.reload();
		await expect(
			viewer.getByRole("button", { name: "Create project", exact: true })
		).toBeVisible();

		await role.selectOption("viewer");
		await expect(role).toHaveValue("viewer");
		await viewer.reload();
		await expect(
			viewer.getByRole("heading", { name: "Launch pilot", exact: true })
		).toBeVisible();
		await expect(
			viewer.getByRole("button", { name: "Create project", exact: true })
		).toHaveCount(0);

		const projectsURL = new URL(viewer.url());
		projectsURL.pathname = `/api${projectsURL.pathname.slice("/app".length)}`;
		expect(
			(await context.request.get(projectsURL.toString())).status()
		).toBe(200);
		page.once("dialog", (dialog) => dialog.accept());
		await page
			.getByRole("listitem")
			.filter({ has: role })
			.getByRole("button", { name: "Remove", exact: true })
			.click();
		await expect(role).toHaveCount(0);
		const denied = await context.request.get(projectsURL.toString());
		expect(denied.status()).toBe(404);
	} finally {
		await context.close();
	}
});
