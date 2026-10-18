import { expect, test } from "@playwright/test";
import { joinedViewer, roleLabel } from "./organizations";

test("member changes refresh role controls and revoke organization access", async ({
	page,
	browser,
	baseURL,
}) => {
	const context = await browser.newContext();
	try {
		const { viewer } = await joinedViewer(page, context, baseURL);
		// Acceptance happened in another browser context; refresh the owner's list.
		await page.reload();
		const row = page
			.getByRole("listitem")
			.filter({ hasText: "viewer@example.test" });
		// Access changes and removal live in the row's menu.
		const actions = row.getByRole("button", {
			name: "Actions for viewer",
			exact: true,
		});
		await actions.click();
		await page
			.getByRole("menuitem", { name: "Make editor", exact: true })
			.click();
		await expect(row.getByText("Editor", { exact: true })).toBeVisible();
		await viewer.reload();
		await expect(roleLabel(viewer, "editor")).toBeVisible();

		await actions.click();
		await page
			.getByRole("menuitem", { name: "Make viewer", exact: true })
			.click();
		await expect(row.getByText("Viewer", { exact: true })).toBeVisible();
		await viewer.reload();
		await expect(roleLabel(viewer, "viewer")).toBeVisible();
		await expect(roleLabel(viewer, "editor")).toHaveCount(0);

		const membersURL = new URL(viewer.url());
		membersURL.pathname = `/api${membersURL.pathname.slice("/app".length)}`;
		expect(
			(await context.request.get(membersURL.toString())).status()
		).toBe(200);
		page.once("dialog", (dialog) => dialog.accept());
		await actions.click();
		await page
			.getByRole("menuitem", { name: "Remove", exact: true })
			.click();
		await expect(row).toHaveCount(0);
		const denied = await context.request.get(membersURL.toString());
		expect(denied.status()).toBe(404);
	} finally {
		await context.close();
	}
});
