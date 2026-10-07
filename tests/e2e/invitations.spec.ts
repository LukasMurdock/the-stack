import { expect, test } from "@playwright/test";
import { createOrganization, createProject } from "./organizations";

test("invitation acceptance survives a lost response and grants viewer access", async ({
	page,
	browser,
}) => {
	const name = await createOrganization(page);
	await createProject(page);
	await page.getByRole("link", { name: "Members", exact: true }).click();
	await page.getByLabel("Email address").fill("viewer@example.test");
	await page.getByRole("button", { name: "Create invitation" }).click();
	const invitation = page.getByLabel("Invitation link");
	await expect(invitation).toBeVisible();
	const link = await invitation.inputValue();
	const token = new URL(link).hash.slice(1);
	const viewerContext = await browser.newContext();
	try {
		const viewer = await viewerContext.newPage();
		await viewer.goto(link);
		await viewer
			.getByRole("link", { name: "Sign in", exact: true })
			.click();
		await expect(
			viewer.getByRole("heading", { name: "Sign in", exact: true })
		).toBeVisible();
		expect(viewer.url()).not.toContain(token);
		await viewer
			.getByLabel("Email", { exact: true })
			.fill("viewer@example.test");
		await viewer
			.getByLabel("Password", { exact: true })
			.fill("Browser-test-password-123!");
		await viewer
			.getByRole("button", { name: "Sign in", exact: true })
			.click();
		// The first response is lost after the server commits membership.
		await viewer.route("**/api/invitations/accept", async (route) => {
			await route.fetch();
			await route.abort();
		});
		await viewer.getByRole("button", { name: "Accept invitation" }).click();
		await expect(viewer.getByRole("alert")).toBeVisible();
		await viewer.unroute("**/api/invitations/accept");
		await viewer.getByRole("button", { name: "Accept invitation" }).click();
		await expect(viewer.getByRole("status")).toHaveText(
			`You joined ${name}.`
		);
		expect(viewer.url()).not.toContain(token);
		await viewer.getByRole("link", { name: "Open organization" }).click();
		await expect(
			viewer.getByRole("button", { name: "Create invitation" })
		).toHaveCount(0);
		await viewer
			.getByRole("link", { name: "Projects", exact: true })
			.click();
		await expect(
			viewer.getByRole("heading", { name: "Launch pilot", exact: true })
		).toBeVisible();
		await expect(
			viewer.getByRole("button", { name: "Create project", exact: true })
		).toHaveCount(0);
	} finally {
		await viewerContext.close();
	}
});

test("invited users can register under restricted signup and verify in a new tab", async ({
	page,
	browser,
}) => {
	const name = await createOrganization(page);
	const email = `new-browser-${crypto.randomUUID()}@example.test`;
	await page.getByLabel("Email address").fill(email);
	await page.getByRole("button", { name: "Create invitation" }).click();
	await expect(page.getByLabel("Invitation link")).toBeVisible();
	const link = await page.getByLabel("Invitation link").inputValue();
	const token = new URL(link).hash.slice(1);
	const context = await browser.newContext();
	// Invitation onboarding must also work when browser storage is unavailable.
	await context.addInitScript(() => {
		Object.defineProperty(window, "sessionStorage", {
			get() {
				throw new Error("Storage denied");
			},
		});
	});
	try {
		const invited = await context.newPage();
		await invited.goto(link);

		await invited
			.getByLabel("Name", { exact: true })
			.fill("New browser member");
		await invited.getByLabel("Email", { exact: true }).fill(email);
		await invited
			.getByLabel("Password", { exact: true })
			.fill("New-browser-password-983724!");
		await invited
			.getByRole("button", { name: "Create account", exact: true })
			.click();
		await expect(
			invited.getByRole("heading", { name: "Join an organization" })
		).toBeVisible();
		await expect(
			invited.getByRole("button", { name: "Send verification email" })
		).toBeVisible();
		expect(invited.url()).not.toContain(token);
		// Deliver the same signed verification link as Better Auth's email. No real
		// email is sent; server verification and redirects still run normally.
		const { createEmailVerificationToken } =
			await import("better-auth/api");
		const verificationToken = await createEmailVerificationToken(
			"browser-test-secret-not-for-real-environments",
			email
		);
		const verification = await context.newPage();
		await verification.goto(
			`/api/auth/verify-email?token=${encodeURIComponent(verificationToken)}&callbackURL=${encodeURIComponent(link)}`
		);
		await expect(
			verification.getByRole("heading", { name: "Join an organization" })
		).toBeVisible();
		expect(verification.url()).not.toContain(token);
		await verification
			.getByRole("button", { name: "Accept invitation" })
			.click();
		await expect(verification.getByRole("status")).toHaveText(
			`You joined ${name}.`
		);
		await verification
			.getByRole("link", { name: "Open organization" })
			.click();
		await expect(
			verification.getByRole("button", { name: "Create invitation" })
		).toHaveCount(0);
	} finally {
		await context.close();
	}
});
