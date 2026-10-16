import assert from "node:assert/strict";
import test from "node:test";
import {
	describeEmailDelivery,
	type EmailDeliveryInput,
} from "../../src/contracts/email-delivery";

const production: EmailDeliveryInput = {
	appEnv: "production",
	transport: "cloudflare",
	sender: "noreply@mail.company.com",
	sendEmailBinding: "present",
	resendApiKey: "absent",
};

test("a configured provider can send", () => {
	assert.deepEqual(describeEmailDelivery(production), {
		delivery: "provider",
		transport: "cloudflare",
	});
	assert.deepEqual(
		describeEmailDelivery({ ...production, transport: undefined }),
		{ delivery: "provider", transport: "cloudflare" },
		"production defaults to Cloudflare"
	);
	assert.deepEqual(
		describeEmailDelivery({
			...production,
			transport: "resend",
			sender: "Team <noreply@company.com>",
			resendApiKey: "present",
		}),
		{ delivery: "provider", transport: "resend" }
	);
});

test("local environments log instead of sending", () => {
	for (const appEnv of ["local", "dev", "development", "test"])
		assert.deepEqual(
			describeEmailDelivery({
				...production,
				appEnv,
				transport: undefined,
				sender: "noreply@localhost.test",
			}),
			{ delivery: "log_only" },
			appEnv
		);
});

test("each missing piece names its reason", () => {
	const cases: ReadonlyArray<readonly [Partial<EmailDeliveryInput>, RegExp]> =
		[
			[{ transport: "log" }, /only works in local/],
			[{ transport: "smtp" }, /must be cloudflare, resend, or log/],
			[{ sender: undefined }, /not a sender mailbox/],
			[{ sender: "noreply" }, /not a sender mailbox/],
			[{ sender: "noreply@" }, /not a sender mailbox/],
			[
				{ sender: "noreply@your-app.example" },
				/placeholder domain your-app\.example/,
			],
			[
				{ sender: "App <noreply@app.test>" },
				/placeholder domain app\.test/,
			],
			[{ sender: "noreply@mail.example.com" }, /placeholder domain/],
			[
				{ sender: "noreply@EXAMPLE.ORG" },
				/placeholder domain example\.org/,
			],
			[{ sendEmailBinding: "absent" }, /SEND_EMAIL binding/],
			[{ transport: "resend" }, /needs RESEND_API_KEY/],
		];
	for (const [override, reason] of cases) {
		const status = describeEmailDelivery({ ...production, ...override });
		assert.equal(status.delivery, "unavailable", JSON.stringify(override));
		if (status.delivery === "unavailable")
			assert.match(status.reason, reason);
	}
	assert.equal(
		describeEmailDelivery({
			...production,
			sender: "noreply@notexample.com",
		}).delivery,
		"provider",
		"only reserved names are placeholders"
	);
});
