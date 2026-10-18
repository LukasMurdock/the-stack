import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { z } from "zod";
import { e2ePaths } from "../../scripts/testing/e2e.ts";
import { createdUserResponseSchema } from "../../src/contracts/admin-users";

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
		// Anchored: the actions cell names the email in its menu button.
		page.getByRole("cell", { name: new RegExp(`^${email}`) })
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

// Browser runs send no real email; the log-only transport writes the link to
// the server log. The same link is rebuilt from the reset token Better Auth
// stored in this run's local D1 (auth_storage, its secondary storage).
const d1OutputSchema = z
	.array(z.object({ results: z.array(z.object({ key: z.string() })) }))
	.length(1);
const RESET_TOKEN_KEY_PREFIX = "verification:reset-password:";

// userId comes from the server's create-user response (Better Auth's
// alphanumeric ids), so it is safe to inline into the SQL text.
function emailedResetLink(userId: string, baseURL: string): string {
	const paths = e2ePaths(Number(process.env.STACK_E2E_PORT));
	const output = execFileSync(
		"pnpm",
		[
			"exec",
			"wrangler",
			"d1",
			"execute",
			"CORE_DB",
			"--local",
			"--json",
			"--config",
			paths.config,
			"--persist-to",
			paths.state,
			"--command",
			`select key from auth_storage where key like '${RESET_TOKEN_KEY_PREFIX}%' and json_extract(value, '$.value') = '${userId}'`,
		],
		{ encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
	);
	const [result] = d1OutputSchema.parse(JSON.parse(output));
	expect(result.results).toHaveLength(1);
	const token = result.results[0].key.slice(RESET_TOKEN_KEY_PREFIX.length);
	const callback = encodeURIComponent(`${baseURL}/app/reset-password`);
	return `/api/auth/reset-password/${token}?callbackURL=${callback}`;
}

test("an administrator emails a sign-in link that lets the person set a password and sign in", async ({
	page,
	browser,
	baseURL,
}) => {
	expect(baseURL).toBeDefined();
	await signIn(page, {
		email: "admin@example.test",
		password: fixturePassword,
	});
	// Precondition over HTTP: someone with an account and no known password.
	const email = `linked-${crypto.randomUUID()}@example.test`;
	const response = await page.request.post("/api/internal/users", {
		data: {
			name: "Linked Person",
			email,
			role: "user",
			emailVerification: "verified",
		},
	});
	expect(response.status()).toBe(201);
	const { user } = createdUserResponseSchema.parse(await response.json());

	await page.goto("/app/ts_admin/users");
	const confirmations: string[] = [];
	page.on("dialog", async (dialog) => {
		confirmations.push(dialog.message());
		await dialog.accept();
	});
	await page
		.getByRole("button", { name: `More actions for ${email}` })
		.click();
	await page.getByRole("menuitem", { name: "Send sign-in link" }).click();
	await expect(page.getByRole("status")).toHaveText(
		`Sign-in link sent to ${email}`
	);
	expect(confirmations).toEqual([
		`Email ${email} a link to set their password and sign in?`,
	]);
	const link = emailedResetLink(user.id, String(baseURL));

	// The user's own page offers the same action; a second link inside the
	// cooldown is refused with the wait.
	await page.goto(`/app/ts_admin/users/${user.id}`);
	await page.getByRole("button", { name: "Send sign-in link" }).click();
	await expect(page.getByRole("alert")).toContainText(
		`A sign-in link was just sent to ${email}. Try again in`
	);

	const context = await browser.newContext();
	try {
		const linked = await context.newPage();
		await linked.goto(link);
		await expect(linked).toHaveURL(/\/app\/reset-password\?token=/);
		const password = "Linked-browser-password-58213!";
		await linked.getByLabel("New password", { exact: true }).fill(password);
		await linked
			.getByLabel("Confirm password", { exact: true })
			.fill(password);
		await linked
			.getByRole("button", { name: "Set new password", exact: true })
			.click();
		await expect(linked).toHaveURL(/\/app\/login/);
		await signIn(linked, { email, password });
	} finally {
		await context.close();
	}
});
