import { expect, test, type Page } from "@playwright/test";
import { createdUserResponseSchema } from "../../src/contracts/admin-users";
import { chooseFromAccountMenu } from "./account-menu";

const fixturePassword = "Browser-test-password-123!";
const changedPassword = "Changed-browser-password-492873!";

async function signIn(page: Page, email: string, password: string) {
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill(email);
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

test("a person replaces the starting password an administrator gave them", async ({
	page,
	browser,
}) => {
	await signIn(page, "admin@example.test", fixturePassword);
	await expect(page).not.toHaveURL(/\/app\/login/);
	const email = `changer-${Date.now()}@example.test`;
	// Creation hashes with scrypt and checks a remote corpus; allow for load.
	const created = await page.request.post("/api/internal/users", {
		data: {
			name: "Changer",
			email,
			role: "user",
			emailVerification: "verified",
		},
		timeout: 20_000,
	});
	expect(created.status()).toBe(201);
	const { startingPassword } = createdUserResponseSchema.parse(
		await created.json()
	);

	const context = await browser.newContext();
	const person = await context.newPage();
	await signIn(person, email, startingPassword);
	await expect(person).not.toHaveURL(/\/app\/login/);
	await chooseFromAccountMenu(person, "Account");
	await expect(
		person.getByRole("heading", { name: "Change password" })
	).toBeVisible();
	await person.getByLabel("Current password").fill(startingPassword);
	await person
		.getByLabel("New password", { exact: true })
		.fill(changedPassword);
	await person.getByLabel("Confirm new password").fill(changedPassword);
	await expect(person.getByLabel("Sign out other sessions")).toBeChecked();
	await person.getByRole("button", { name: "Change password" }).click();
	await expect(person.getByRole("status")).toContainText(
		"Password changed.",
		{ timeout: 20_000 }
	);
	await context.close();

	const fresh = await browser.newContext();
	const again = await fresh.newPage();
	await signIn(again, email, startingPassword);
	await expect(again.getByRole("alert")).toBeVisible();
	await expect(again).toHaveURL(/\/app\/login/);
	await signIn(again, email, changedPassword);
	await expect(again).not.toHaveURL(/\/app\/login/);
	await fresh.close();
});
