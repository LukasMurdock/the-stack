import { expect, test } from "@playwright/test";

const fixturePassword = "Browser-test-password-123!";

async function signIn(
	page: import("@playwright/test").Page,
	credential: { email: string; password: string }
) {
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill(credential.email);
	await page
		.getByLabel("Password", { exact: true })
		.fill(credential.password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).not.toHaveURL(/\/app\/login/);
}

test("an administrator creates a user who signs in with the starting password", async ({
	page,
	browser,
}) => {
	await signIn(page, {
		email: "admin@example.test",
		password: fixturePassword,
	});
	await page.goto("/app/ts_admin/users");
	await expect(
		page.getByText("This environment logs email instead of sending it.")
	).toBeVisible();
	await page.getByRole("button", { name: "Create user" }).click();
	const dialog = page.getByRole("dialog");
	const email = `created-${Date.now()}@example.test`;
	await dialog.getByLabel("Name", { exact: true }).fill("Created Person");
	await dialog.getByLabel("Email", { exact: true }).fill(email);
	await expect(dialog.getByLabel("Mark email as verified")).toBeChecked();
	await dialog.getByRole("button", { name: "Create user" }).click();
	// Creation hashes with scrypt and checks the password against a remote
	// corpus; allow for a loaded machine.
	await expect(dialog.getByText("User created")).toBeVisible({
		timeout: 20_000,
	});
	const passwordField = dialog.getByLabel("Starting password");
	const startingPassword = await passwordField.inputValue();
	expect(startingPassword).toHaveLength(24);
	// Session replay must never capture the value.
	await expect(dialog.locator(".rr-block")).toContainText(
		"Starting password"
	);
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("cell", { name: new RegExp(email) })
	).toBeVisible();

	// Reopening shows a fresh form: the password is gone from the page.
	await page.getByRole("button", { name: "Create user" }).click();
	await expect(
		page.getByRole("dialog").getByLabel("Name", { exact: true })
	).toHaveValue("");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();

	const duplicate = page.getByRole("dialog");
	await page.getByRole("button", { name: "Create user" }).click();
	await duplicate.getByLabel("Name", { exact: true }).fill("Again");
	await duplicate
		.getByLabel("Email", { exact: true })
		.fill(email.toUpperCase());
	await duplicate.getByRole("button", { name: "Create user" }).click();
	await expect(duplicate.getByRole("alert")).toContainText("already exists");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toBeHidden();

	const context = await browser.newContext();
	const newUser = await context.newPage();
	await signIn(newUser, { email, password: startingPassword });
	await context.close();
});
