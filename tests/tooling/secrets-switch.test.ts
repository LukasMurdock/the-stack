import assert from "node:assert/strict";
import test from "node:test";
import {
	deploymentCloudflare,
	productionSecretNames,
	secretsStorePrefix,
} from "../../config/cloudflare.mjs";
import {
	activeVersion,
	bridgeConfig,
	deletionPayload,
	isBindingNameConflict,
	parseBookmark,
	parseLoggedIn,
	parseVersionBindings,
	plainSecretNames,
	type Preflight,
	preflightProblems,
	readinessProblem,
	splitByValueSource,
	storeBindingsVerdict,
	turretProblem,
	unusableSecrets,
	uploadedPreviewUrl,
	uploadedVersionId,
} from "../../scripts/lib/secrets-switch.ts";
import {
	NEW_SECRET_BYTES,
	newSecretValue,
	parseSecretsSwitchOptions,
} from "../../scripts/secrets-switch.ts";
import { workerSecrets } from "../../src/contracts/secrets.ts";

// The switch runs once against a live Worker, so its decisions are tested
// here; the Cloudflare calls themselves are not (no account in tests).

const STORE = "a".repeat(32);
const VERSION = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
// The template's own bindings, as deploy resolves them.
const entries = deploymentCloudflare.secrets_store_secrets.map((entry) => ({
	...entry,
	store_id: STORE,
}));
const storeBindings = entries.map((entry) => ({
	name: entry.binding,
	type: "secrets_store_secret",
	store_id: entry.store_id,
	secret_name: entry.secret_name,
}));

test("the switch binds the template's productionSecretNames under the store prefix", () => {
	assert.deepEqual(
		entries.map((entry) => [entry.binding, entry.secret_name]),
		productionSecretNames.map((name) => [
			name,
			`${secretsStorePrefix}${name}`,
		])
	);
});

test("switch options: a dry run unless --execute, and the phase is named", () => {
	assert.deepEqual(parseSecretsSwitchOptions(["switch"]), {
		kind: "run",
		options: {
			phase: "switch",
			execute: false,
			expectVersion: null,
			allowAuthWindow: false,
		},
	});
	assert.deepEqual(
		parseSecretsSwitchOptions([
			"switch",
			"--execute",
			"--expect-version",
			"1400633f",
			"--allow-auth-window",
		]),
		{
			kind: "run",
			options: {
				phase: "switch",
				execute: true,
				expectVersion: "1400633f",
				allowAuthWindow: true,
			},
		}
	);
	assert.deepEqual(parseSecretsSwitchOptions(["store", "--dry-run"]), {
		kind: "run",
		options: {
			phase: "store",
			execute: false,
			expectVersion: null,
			allowAuthWindow: false,
		},
	});
	assert.deepEqual(parseSecretsSwitchOptions(["-h"]), { kind: "help" });
});

test("only secrets the app mints get a random value, each above its minimum", () => {
	const values = new Set(Array.from({ length: 50 }, newSecretValue));
	assert.equal(values.size, 50);
	const length = Math.ceil((NEW_SECRET_BYTES * 4) / 3);
	for (const value of values)
		assert.match(value, new RegExp(`^[A-Za-z0-9_-]{${length}}$`));
	for (const spec of Object.values(workerSecrets))
		if (spec.generated) assert.ok(length >= spec.lengthMin);
	const entry = (binding: string) => ({
		binding,
		store_id: STORE,
		secret_name: `${secretsStorePrefix}${binding}`,
	});
	const { generated, provided } = splitByValueSource(
		[
			"BETTER_AUTH_SECRET",
			"RESEND_API_KEY",
			"TURRET_SIGNING_KEY",
			"GOOGLE_CLIENT_SECRET",
		].map(entry)
	);
	assert.deepEqual(
		generated.map((secret) => secret.binding),
		["BETTER_AUTH_SECRET", "TURRET_SIGNING_KEY"]
	);
	assert.deepEqual(
		provided.map((secret) => secret.binding),
		["RESEND_API_KEY", "GOOGLE_CLIENT_SECRET"]
	);
});

test("Wrangler's output is read for credentials, traffic, bindings and bookmarks", () => {
	assert.equal(parseLoggedIn('{"loggedIn":false}'), false);
	assert.equal(parseLoggedIn('{"loggedIn":true,"email":"a@b.c"}'), true);
	const status = (versions: unknown) => JSON.stringify({ id: "d", versions });
	assert.equal(
		activeVersion(status([{ version_id: VERSION, percentage: 100 }])),
		VERSION
	);
	assert.equal(
		activeVersion(
			status([
				{ version_id: VERSION, percentage: 90 },
				{ version_id: "other", percentage: 10 },
			])
		),
		null
	);
	assert.deepEqual(
		parseVersionBindings(
			JSON.stringify({
				id: VERSION,
				resources: {
					bindings: [
						{ name: "BETTER_AUTH_SECRET", type: "secret_text" },
					],
				},
			})
		),
		[{ name: "BETTER_AUTH_SECRET", type: "secret_text" }]
	);
	assert.equal(
		parseBookmark(
			'🚧 Time Traveling...\n{\n  "bookmark": "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"\n}\n'
		),
		"00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683"
	);
	assert.throws(() => parseBookmark("✘ [ERROR] no"), /printed no JSON/);
});

test("the uploaded version, its preview URL and a binding name conflict are read from Wrangler", () => {
	const upload = `Uploaded the-stack (4.2 sec)\nWorker Version ID: ${VERSION}\nVersion Preview URL: https://0f1e2d3c-the-stack.acme.workers.dev\n`;
	assert.equal(uploadedVersionId(upload), VERSION);
	assert.equal(
		uploadedPreviewUrl(upload),
		"https://0f1e2d3c-the-stack.acme.workers.dev"
	);
	assert.equal(uploadedVersionId("no id"), null);
	assert.equal(uploadedPreviewUrl(`Worker Version ID: ${VERSION}`), null);
	assert.ok(
		isBindingNameConflict(
			"Binding name 'BETTER_AUTH_SECRET' already in use. Please use a different name and try again. [code: 10053]"
		)
	);
	assert.ok(!isBindingNameConflict("Authentication error [code: 10000]"));
});

test("a version takes traffic only if it binds every secret from the configured Store entry", () => {
	assert.deepEqual(storeBindingsVerdict(entries, storeBindings), {
		kind: "store",
	});
	const [first, ...rest] = storeBindings;
	assert.ok(first);
	const kept = storeBindingsVerdict(entries, [
		{ name: first.name, type: "secret_text" },
		...rest,
	]);
	assert.equal(kept.kind, "not-store");
	assert.match(
		JSON.stringify(kept),
		/BETTER_AUTH_SECRET is still a plain secret \(secret_text\)/
	);
	const wrong = storeBindingsVerdict(entries, [
		{ ...first, secret_name: "OTHER" },
	]);
	assert.match(
		JSON.stringify(wrong),
		new RegExp(
			`binds a{32}/OTHER, not a{32}/${secretsStorePrefix}BETTER_AUTH_SECRET`
		)
	);
	assert.match(JSON.stringify(wrong), /BOOTSTRAP_SECRET is not bound/);
	assert.deepEqual(
		plainSecretNames([
			{ name: "B", type: "secret_text" },
			{ name: "A", type: "secret_key" },
			{ name: "C", type: "secrets_store_secret" },
		]),
		["A", "B"]
	);
});

test("a store secret is usable only if it exists with the workers scope", () => {
	const [auth, bootstrap, turret] = entries;
	assert.ok(auth && bootstrap && turret);
	const { missing, unscoped } = unusableSecrets(entries, [
		{ name: auth.secret_name, scopes: ["workers"] },
		{ name: bootstrap.secret_name, scopes: ["ai_gateway"] },
	]);
	assert.deepEqual(missing, [turret]);
	assert.deepEqual(unscoped, [bootstrap]);
});

test("the bridge drops only the Store bindings; deletion is one request", () => {
	assert.deepEqual(
		bridgeConfig({
			name: "w",
			secrets_store_secrets: [{ binding: "X" }],
			vars: { A: "b" },
		}),
		{ name: "w", vars: { A: "b" }, secrets_store_secrets: [] }
	);
	assert.equal(
		deletionPayload(["BETTER_AUTH_SECRET", "BOOTSTRAP_SECRET"]),
		'{"BETTER_AUTH_SECRET":null,"BOOTSTRAP_SECRET":null}'
	);
});

test("preflight refuses everything that would make the switch unsafe", () => {
	const ready: Preflight = {
		cleanMain: true,
		storeRecorded: true,
		unusableSecrets: [],
		unboundPlain: [],
		activeVersion: VERSION,
		expectedVersion: "0f1e2d3c",
	};
	assert.deepEqual(preflightProblems(ready), []);
	assert.deepEqual(
		preflightProblems({ ...ready, expectedVersion: null }),
		[]
	);
	const problems = preflightProblems({
		cleanMain: false,
		storeRecorded: false,
		unusableSecrets: [`${secretsStorePrefix}BETTER_AUTH_SECRET`],
		unboundPlain: ["LEGACY_TOKEN"],
		activeVersion: VERSION,
		expectedVersion: "1400633f",
	}).join("\n");
	for (const pattern of [
		/clean main at origin\/main/,
		/records no Secrets Store; run `pnpm secrets:switch store --execute`/,
		new RegExp(
			`lacks .*${secretsStorePrefix}BETTER_AUTH_SECRET.*create-secrets`
		),
		/does not bind from the Store: LEGACY_TOKEN/,
		/not 1400633f \(--expect-version\)/,
	])
		assert.match(problems, pattern);
	assert.match(
		preflightProblems({ ...ready, activeVersion: null }).join("\n"),
		/not one version at 100%/
	);
});

test("anonymous probes: readiness lists no missing secret, Turret runs as configured", () => {
	const readiness = (missingRequired: string[]) =>
		JSON.stringify({ ok: true, secrets: { missingRequired } });
	assert.equal(readinessProblem(200, readiness([])), null);
	assert.match(
		readinessProblem(503, readiness(["BETTER_AUTH_SECRET"])) ?? "",
		/503, secrets\.missingRequired \["BETTER_AUTH_SECRET"\]/
	);
	assert.match(
		readinessProblem(502, "<html>Bad gateway</html>") ?? "",
		/502 without secrets\.missingRequired/
	);
	const health = (configuredMode: string, effectiveMode: string) =>
		JSON.stringify({ turret: { configuredMode, effectiveMode } });
	assert.equal(turretProblem(health("full", "full")), null);
	assert.equal(turretProblem(health("basic", "basic")), null);
	assert.match(
		turretProblem(health("full", "basic")) ?? "",
		/TURRET_SIGNING_KEY did not resolve/
	);
	assert.match(turretProblem("not json") ?? "", /no turret mode/);
});
