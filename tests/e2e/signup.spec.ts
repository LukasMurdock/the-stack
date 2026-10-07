import { expect, test } from "@playwright/test";
import { passwordSchema } from "../../src/contracts/auth";

test("public signup derives password bounds while sign-in accepts existing credentials", async ({
	page,
}) => {
	await page.route("**/api/health", async (route) => {
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({
			response,
			json: { ...body, auth: { ...body.auth, selfSignUpEnabled: true } },
		});
	});
	await page.goto("/app/login");
	const password = page.getByLabel("Password", { exact: true });
	await expect(password).not.toHaveAttribute("minlength");
	await expect(password).not.toHaveAttribute("maxlength");
	await page.getByRole("button", { name: "Create one", exact: true }).click();
	await expect(password).toHaveAttribute(
		"minlength",
		String(passwordSchema.minLength)
	);
	await expect(password).toHaveAttribute(
		"maxlength",
		String(passwordSchema.maxLength)
	);
	await page.getByLabel("Name", { exact: true }).fill("Test signup");
	await page.getByLabel("Email", { exact: true }).fill("signup@example.test");
	await password.pressSequentially("short");
	await page
		.getByRole("button", { name: "Create account", exact: true })
		.click();
	expect(
		await password.evaluate(
			(input: HTMLInputElement) => input.validity.tooShort
		)
	).toBe(true);
	await password.fill("");
	await password.pressSequentially("x".repeat(129));
	await expect(password).toHaveValue("x".repeat(128));
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(password).not.toHaveAttribute("minlength");
	await expect(password).not.toHaveAttribute("maxlength");
});
