import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
	productionSecretNames,
	secretsStorePrefix,
	deploymentCloudflare,
	localCloudflare,
} from "../../config/cloudflare.mjs";
import {
	SECRET_NAMES,
	SECRET_VALUE_BYTES_MAX,
	requiredSecretNames,
	workerSecrets,
} from "../../src/contracts/secrets";
import {
	MissingSecretError,
	missingRequiredSecrets,
	parseSecretValue,
	requireSecret,
	resolveSecrets,
	withResolvedSecrets,
} from "../../src/worker/secrets";

const AUTH_SECRET = "a-store-secret-of-at-least-thirty-two-characters";

// The binding shape Cloudflare gives a Worker for a Secrets Store secret.
function storeSecret(value: string): SecretsStoreSecret {
	return { get: () => Promise.resolve(value) };
}

function failingStoreSecret(message: string): SecretsStoreSecret {
	return { get: () => Promise.reject(new Error(message)) };
}

function captureErrors(t: TestContext): unknown[][] {
	const calls: unknown[][] = [];
	t.mock.method(console, "error", (...args: unknown[]) => {
		calls.push(args);
	});
	return calls;
}

test("the contract lists every secret once, and production binds every required one", () => {
	assert.deepEqual(
		[...SECRET_NAMES].sort(),
		Object.keys(workerSecrets).sort()
	);
	assert.deepEqual(requiredSecretNames(), ["BETTER_AUTH_SECRET"]);
	for (const name of requiredSecretNames())
		assert.ok(productionSecretNames.includes(name));
	assert.deepEqual(
		deploymentCloudflare.secrets_store_secrets.map((entry) => [
			entry.binding,
			entry.secret_name,
		]),
		productionSecretNames.map((name) => [
			name,
			`${secretsStorePrefix}${name}`,
		])
	);
	assert.equal(secretsStorePrefix, "THE_STACK_");
	// Local development keeps .env strings; the local config binds no Store.
	assert.equal("secrets_store_secrets" in localCloudflare, false);
});

test("values are validated once: blank is absent, length bounds are invalid", () => {
	assert.deepEqual(parseSecretValue("BOOTSTRAP_SECRET", "  \n"), {
		kind: "absent",
	});
	assert.deepEqual(parseSecretValue("BETTER_AUTH_SECRET", "short"), {
		kind: "invalid",
		reason: "shorter than 32 characters",
	});
	assert.deepEqual(
		parseSecretValue(
			"RESEND_API_KEY",
			"x".repeat(SECRET_VALUE_BYTES_MAX + 1)
		),
		{
			kind: "invalid",
			reason: `longer than ${SECRET_VALUE_BYTES_MAX} bytes`,
		}
	);
	assert.deepEqual(parseSecretValue("BETTER_AUTH_SECRET", AUTH_SECRET), {
		kind: "present",
		value: AUTH_SECRET,
	});
});

test("Store bindings and plain strings resolve to the same strings", async (t) => {
	const errors = captureErrors(t);
	const resolved = await resolveSecrets({
		BETTER_AUTH_SECRET: storeSecret(AUTH_SECRET),
		TURRET_SIGNING_KEY: "plain-local-key",
		BOOTSTRAP_SECRET: storeSecret("   "),
	});
	assert.deepEqual(resolved, {
		BETTER_AUTH_SECRET: AUTH_SECRET,
		TURRET_SIGNING_KEY: "plain-local-key",
	});
	assert.equal(requireSecret(resolved, "BETTER_AUTH_SECRET"), AUTH_SECRET);
	assert.deepEqual(missingRequiredSecrets(resolved), []);
	assert.deepEqual(errors, []);
});

test("an unreadable or invalid secret is reported by name, never by value, and treated as absent", async (t) => {
	const errors = captureErrors(t);
	const resolved = await resolveSecrets({
		BETTER_AUTH_SECRET: storeSecret("too-short-secret-value"),
		TURRET_SIGNING_KEY: failingStoreSecret('Secret "X" not found'),
	});
	assert.deepEqual(resolved, {});
	assert.deepEqual(missingRequiredSecrets(resolved), ["BETTER_AUTH_SECRET"]);
	assert.deepEqual(
		errors.map(([entry]) => entry),
		[
			{
				action: "secrets.unavailable",
				secret: "BETTER_AUTH_SECRET",
				requirement: "required",
				state: "invalid",
				reason: "shorter than 32 characters",
			},
			{
				action: "secrets.unavailable",
				secret: "TURRET_SIGNING_KEY",
				requirement: "optional",
				state: "unreadable",
				reason: 'Secret "X" not found',
			},
		]
	);
	assert.ok(!JSON.stringify(errors).includes("too-short-secret-value"));
	assert.throws(
		() => requireSecret(resolved, "BETTER_AUTH_SECRET"),
		(error: unknown) =>
			error instanceof MissingSecretError &&
			/BETTER_AUTH_SECRET is not configured.*Secrets Store/.test(
				error.message
			)
	);
});

test("the request env carries resolved strings and no Store binding objects", async () => {
	const binding = storeSecret("unused-because-absent");
	const env = {
		APP_ENV: "production",
		BETTER_AUTH_SECRET: storeSecret(AUTH_SECRET),
		GOOGLE_CLIENT_ID: binding,
	};
	const secrets = await resolveSecrets({
		BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
	});
	const resolved = withResolvedSecrets(env, secrets);
	assert.deepEqual(resolved, {
		APP_ENV: "production",
		BETTER_AUTH_SECRET: AUTH_SECRET,
	});
	// The platform's object is never modified.
	assert.equal(env.GOOGLE_CLIENT_ID, binding);
});
