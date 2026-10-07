import { expect, test } from "@playwright/test";

test("recovery requests the mounted callback and legacy links use the same reset form", async ({
	page,
	baseURL,
}) => {
	await page.goto("/app/reset-password");
	await page.getByLabel("Email", { exact: true }).fill("viewer@example.test");
	const requested = page.waitForRequest(
		(request) =>
			new URL(request.url()).pathname ===
			"/api/auth/request-password-reset"
	);
	await page
		.getByRole("button", { name: "Email reset link", exact: true })
		.click();
	expect((await requested).postDataJSON().redirectTo).toBe(
		`${baseURL}/app/reset-password`
	);
	await expect(
		page.getByText("If an account exists for that email", { exact: false })
	).toBeVisible();
	await page.goto("/app/reset-password/invalid-token");
	await expect(page).toHaveURL(/\/app\/reset-password\?token=invalid-token/);
	await page
		.getByLabel("New password", { exact: true })
		.fill("Reset-browser-password-93628!");
	await page
		.getByLabel("Confirm password", { exact: true })
		.fill("Different-browser-password-93628!");
	await page
		.getByRole("button", { name: "Set new password", exact: true })
		.click();
	await expect(
		page.getByText("Passwords do not match.", { exact: true })
	).toBeVisible();
});
