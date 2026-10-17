import { execFileSync } from "node:child_process";
import { expect, test } from "@playwright/test";
import { e2ePaths } from "../../scripts/testing/e2e.ts";
import {
	EMAIL_LAST_SEND_KEY,
	type EmailSendOutcome,
} from "../../src/contracts/email-send-outcome";

const fixturePassword = "Browser-test-password-123!";

// Browser runs send no real email, so the failure is faked through the
// stored record in this run's local CORE_KV, as a provider failure leaves it.
function storeLastSend(outcome: EmailSendOutcome | null) {
	const paths = e2ePaths(Number(process.env.STACK_E2E_PORT));
	const command =
		outcome === null
			? ["delete", EMAIL_LAST_SEND_KEY]
			: ["put", EMAIL_LAST_SEND_KEY, JSON.stringify(outcome)];
	execFileSync(
		"pnpm",
		[
			"exec",
			"wrangler",
			"kv",
			"key",
			...command,
			"--binding",
			"CORE_KV",
			"--local",
			"--config",
			paths.config,
			"--persist-to",
			paths.state,
		],
		{ stdio: "pipe" }
	);
}

test.afterEach(() => storeLastSend(null));

test("admin pages show failing email delivery until a send is accepted", async ({
	page,
}) => {
	const failed: EmailSendOutcome = {
		outcome: "failed",
		atMs: Date.now(),
		type: "reset-password",
		provider: "cloudflare",
		code: "E_SENDER_DOMAIN_NOT_AVAILABLE",
		message:
			"email sending not authorized for subdomain 'mail.company.com'",
	};
	storeLastSend(failed);
	await page.goto("/app/login");
	await page.getByLabel("Email", { exact: true }).fill("admin@example.test");
	await page.getByLabel("Password", { exact: true }).fill(fixturePassword);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page).not.toHaveURL(/\/app\/login/);

	await page.goto("/app/ts_admin/users");
	const banner = page.getByRole("alert").filter({
		hasText: "Email delivery is failing.",
	});
	await expect(banner).toBeVisible();
	await expect(banner).toContainText(failed.message ?? "");
	await expect(banner).toContainText("E_SENDER_DOMAIN_NOT_AVAILABLE");
	await expect(banner).toContainText(
		"invitations, password reset, email verification"
	);
	await expect(banner).toContainText(
		"onboarded for Cloudflare Email Sending"
	);

	storeLastSend({
		...failed,
		outcome: "accepted",
		code: null,
		message: null,
	});
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Users", exact: true })
	).toBeVisible();
	await expect(banner).toHaveCount(0);
});
