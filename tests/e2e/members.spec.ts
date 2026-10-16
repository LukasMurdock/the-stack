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
		const role = page.getByLabel("Role for viewer", { exact: true });
		await role.selectOption("editor");
		await expect(role).toHaveValue("editor");
		await viewer.reload();
		await expect(roleLabel(viewer, "editor")).toBeVisible();

		await role.selectOption("viewer");
		await expect(role).toHaveValue("viewer");
		await viewer.reload();
		await expect(roleLabel(viewer, "viewer")).toBeVisible();
		await expect(roleLabel(viewer, "editor")).toHaveCount(0);

		const membersURL = new URL(viewer.url());
		membersURL.pathname = `/api${membersURL.pathname.slice("/app".length)}`;
		expect(
			(await context.request.get(membersURL.toString())).status()
		).toBe(200);
		page.once("dialog", (dialog) => dialog.accept());
		await page
			.getByRole("listitem")
			.filter({ has: role })
			.getByRole("button", { name: "Remove", exact: true })
			.click();
		await expect(role).toHaveCount(0);
		const denied = await context.request.get(membersURL.toString());
		expect(denied.status()).toBe(404);
	} finally {
		await context.close();
	}
});
