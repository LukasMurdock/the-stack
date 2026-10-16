import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
	CI_WAIT_TIMEOUT_MINUTES_MAX,
	CI_WAIT_TIMEOUT_MS_DEFAULT,
	parseCiWaitOptions,
} from "../../scripts/ci-wait.ts";
import {
	DEV_PORT_DEFAULT,
	DEV_WAIT_TIMEOUT_SECONDS_DEFAULT,
	parseDevServerOptions,
} from "../../scripts/dev-server.ts";
import {
	LIVE_WAIT_TIMEOUT_MS_DEFAULT,
	parseShipOptions,
} from "../../scripts/ship.ts";
import { parsePrepareE2EOptions } from "../../scripts/testing/prepare-e2e.ts";
import { parseAdminBootstrapOptions } from "../../scripts/admin-bootstrap.ts";
import {
	parseShotOptions,
	SHOT_OUT_DIR_DEFAULT,
	SHOT_PATHS_MAX,
} from "../../scripts/shot.ts";
import { API_REQUEST_BYTES_MAX, parseApiOptions } from "../../scripts/api.ts";
import { parseProofOptions } from "../../scripts/proof.ts";
import {
	parseDemoRecordOptions,
	parseDemoVideoEnv,
} from "../../scripts/demo-record.ts";

// #24: the default --timeout was read as 30 ms instead of 30 minutes, inside
// the entry point that no test ran. These tests parse exactly what a user
// types and run each CLI as a subprocess, the way pnpm does.

const root = process.cwd();
const script = (name: string) => path.join(root, "scripts", name);

function temporaryDirectory(t: test.TestContext, prefix: string) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function runScript(
	name: string,
	args: readonly string[],
	options: { cwd?: string; env?: Record<string, string> } = {}
) {
	return spawnSync(process.execPath, [script(name), ...args], {
		cwd: options.cwd ?? root,
		encoding: "utf8",
		env: { ...process.env, ...options.env },
		timeout: 60_000,
	});
}

function assertUsageError(
	result: ReturnType<typeof runScript>,
	message: RegExp
) {
	assert.equal(result.status, 2, result.stderr);
	assert.match(result.stderr, message);
	assert.match(result.stderr, /Usage:/);
}

test("ci:wait options: defaults, bounds and malformed input", () => {
	assert.deepEqual(parseCiWaitOptions([]), {
		kind: "run",
		options: {
			target: { kind: "ref", ref: "HEAD" },
			ciTimeoutMs: 30 * 60_000,
		},
	});
	assert.equal(CI_WAIT_TIMEOUT_MS_DEFAULT, 30 * 60_000);
	for (const argv of [
		["12", "--timeout", "5"],
		["--timeout=5", "#12"],
	])
		assert.deepEqual(parseCiWaitOptions(argv), {
			kind: "run",
			options: {
				target: { kind: "pr", number: 12 },
				ciTimeoutMs: 300_000,
			},
		});
	const max = String(CI_WAIT_TIMEOUT_MINUTES_MAX);
	const parsedMax = parseCiWaitOptions(["--timeout", max]);
	assert.equal(
		parsedMax.kind === "run" && parsedMax.options.ciTimeoutMs,
		CI_WAIT_TIMEOUT_MINUTES_MAX * 60_000
	);
	assert.deepEqual(parseCiWaitOptions(["-h"]), { kind: "help" });
	for (const [argv, message] of [
		[["--timeout", "0"], /at least 1/],
		[["--timeout", String(CI_WAIT_TIMEOUT_MINUTES_MAX + 1)], /at most/],
		[["--timeout", "Infinity"], /whole number/],
		[["--timeout", "0.5"], /whole number/],
		[["--timeout", ""], /whole number/],
		[["--timeout"], /argument missing/],
		[["--timout", "5"], /Unknown option '--timout'/],
		[["a", "b"], /at most one/],
		[["#0"], /positive integer/],
	] as const)
		assert.throws(() => parseCiWaitOptions(argv), message);
});

test("ship options: defaults, merge methods and malformed input", () => {
	assert.deepEqual(parseShipOptions(["7"]), {
		kind: "run",
		options: {
			pullRequestNumber: 7,
			mergeMethod: "merge",
			ciTimeoutMs: 30 * 60_000,
			liveTimeoutMs: LIVE_WAIT_TIMEOUT_MS_DEFAULT,
		},
	});
	const squash = parseShipOptions(["#7", "--squash", "--timeout=10"]);
	assert.equal(squash.kind, "run");
	if (squash.kind === "run") {
		assert.equal(squash.options.mergeMethod, "squash");
		assert.equal(squash.options.ciTimeoutMs, 600_000);
	}
	for (const [argv, message] of [
		[[], /Missing <pr>/],
		[["main"], /must be a pull request number/],
		[["7", "8"], /Expected one <pr>/],
		[["7", "--sqash"], /Unknown option '--sqash'/],
		[["7", "--squash", "--rebase"], /Choose one merge method/],
		[["7", "--timeout", "x"], /whole number/],
	] as const)
		assert.throws(() => parseShipOptions(argv), message);
});

test("dev-server options: commands, defaults and malformed input", () => {
	assert.deepEqual(parseDevServerOptions([]), {
		kind: "run",
		options: { command: "start", port: DEV_PORT_DEFAULT, astroArgs: [] },
	});
	assert.deepEqual(parseDevServerOptions(["wait"]), {
		kind: "run",
		options: {
			command: "wait",
			devWaitTimeoutMs: DEV_WAIT_TIMEOUT_SECONDS_DEFAULT * 1_000,
		},
	});
	assert.deepEqual(parseDevServerOptions(["stop"]), {
		kind: "run",
		options: { command: "stop" },
	});
	// astro dev flags are validated and forwarded exactly as typed.
	const forwarded = ["--port=4400", "--host", "--open"];
	assert.deepEqual(parseDevServerOptions(["start", ...forwarded]), {
		kind: "run",
		options: { command: "start", port: 4400, astroArgs: forwarded },
	});
	const hostAddress = parseDevServerOptions(["start", "--host", "0.0.0.0"]);
	assert.equal(hostAddress.kind, "run");
	for (const [argv, message] of [
		[["start", "--port", "abc"], /--port must be a whole number/],
		[["start", "--port", "0"], /at least 1/],
		[["start", "--port", "65536"], /at most 65535/],
		[["start", "--bogus"], /Unknown option '--bogus'/],
		[["wait", "--timeout", "abc"], /whole number/],
		[["wait", "--timeout", "0"], /at least 1/],
		[["stop", "now"], /Unexpected argument/],
		[["restart"], /Unknown command: restart/],
	] as const)
		assert.throws(() => parseDevServerOptions(argv), message);
});

test("prepare-e2e options come from STACK_E2E_PORT and STACK_E2E_REBUILD", () => {
	assert.deepEqual(parsePrepareE2EOptions([], {}), {
		kind: "run",
		options: { port: 4322, rebuild: false },
	});
	assert.deepEqual(
		parsePrepareE2EOptions([], {
			STACK_E2E_PORT: "65535",
			STACK_E2E_REBUILD: "1",
		}),
		{ kind: "run", options: { port: 65535, rebuild: true } }
	);
	assert.deepEqual(parsePrepareE2EOptions([], { STACK_E2E_PORT: "1024" }), {
		kind: "run",
		options: { port: 1024, rebuild: false },
	});
	for (const [argv, env, message] of [
		[[], { STACK_E2E_PORT: "1023" }, /between 1024 and 65535/],
		[[], { STACK_E2E_PORT: "65536" }, /between 1024 and 65535/],
		[[], { STACK_E2E_PORT: "0x10e2" }, /between 1024 and 65535/],
		[[], { STACK_E2E_REBUILD: "yes" }, /STACK_E2E_REBUILD/],
		[["extra"], {}, /Unexpected argument/],
	] as const)
		assert.throws(() => parsePrepareE2EOptions(argv, env), message);
});

test("shot options: app-relative paths, viewports, identities and bounds", () => {
	assert.deepEqual(parseShotOptions(["organizations"]), {
		kind: "run",
		options: {
			targets: [
				{ path: "/app/organizations", fileStem: "app-organizations" },
			],
			identity: { kind: "persona", persona: "admin" },
			viewports: [
				{ name: "desktop", width: 1440, height: 900, mobile: false },
			],
			outDir: SHOT_OUT_DIR_DEFAULT,
			fullPage: false,
			server: "dev",
		},
	});
	const parsed = parseShotOptions([
		"/",
		"/docs",
		"/app/organizations",
		"organizations",
		"a-b",
		"a/b",
		"--as",
		"Viewer",
		"--viewport",
		"phone",
		"--viewport=200x4096",
		"--full-page",
		"--e2e",
		"--out",
		"before",
	]);
	assert.equal(parsed.kind, "run");
	if (parsed.kind === "run") {
		assert.deepEqual(
			parsed.options.targets.map(
				(target) => `${target.path} ${target.fileStem}`
			),
			[
				"/ home",
				"/docs docs",
				"/app/organizations app-organizations",
				"/app/a-b app-a-b",
				"/app/a/b app-a-b-2",
			]
		);
		assert.deepEqual(parsed.options.identity, {
			kind: "persona",
			persona: "viewer",
		});
		assert.deepEqual(
			parsed.options.viewports.map((viewport) => viewport.name),
			["phone", "200x4096"]
		);
		assert.equal(parsed.options.server, "e2e");
		assert.equal(parsed.options.fullPage, true);
		assert.equal(parsed.options.outDir, "before");
	}
	const tooMany = Array.from(
		{ length: SHOT_PATHS_MAX + 1 },
		(_, i) => `p${i}`
	);
	assert.equal(parseShotOptions(tooMany.slice(1)).kind, "run");
	for (const [argv, message] of [
		[[], /at least one path/],
		[tooMany, /At most 20 paths/],
		[["x", "--viewport", "tablet"], /phone, desktop or <W>x<H>/],
		[["x", "--viewport", "199x800"], /width must be at least 200/],
		[["x", "--viewport", "800x4097"], /height must be at most 4096/],
		[
			[
				"x",
				"--viewport",
				"phone",
				"--viewport",
				"desktop",
				"--viewport",
				"1x1",
				"--viewport",
				"2x2",
			],
			/At most 3/,
		],
		[["x", "--as", "root"], /--as must be/],
		[["https://example.com/app"], /not a URL/],
		[["//example.com/app"], /not a URL/],
		[["has space"], /whitespace/],
		[[""], /cannot be empty/],
		[["x", "--out", ""], /--out cannot be empty/],
		[["x", "--fullpage"], /Unknown option '--fullpage'/],
	] as const)
		assert.throws(() => parseShotOptions(argv), message);
});

test("api options: methods, app-relative paths, JSON bodies and bounds", () => {
	assert.deepEqual(parseApiOptions(["get", "organizations"]), {
		kind: "run",
		options: {
			method: "GET",
			path: "/api/organizations",
			body: null,
			identity: { kind: "persona", persona: "admin" },
			server: "dev",
		},
	});
	const post = parseApiOptions([
		"POST",
		"/api/organizations?x=1",
		'{"name":"Studio"}',
		"--as",
		"owner@example.test",
		"--e2e",
	]);
	assert.deepEqual(post, {
		kind: "run",
		options: {
			method: "POST",
			path: "/api/organizations?x=1",
			body: '{"name":"Studio"}',
			identity: { kind: "email", email: "owner@example.test" },
			server: "e2e",
		},
	});
	const maxBody = JSON.stringify("x".repeat(API_REQUEST_BYTES_MAX - 2));
	assert.equal(parseApiOptions(["POST", "x", maxBody]).kind, "run");
	for (const [argv, message] of [
		[[], /Give a method and a path/],
		[["GET"], /Give a method and a path/],
		[["HEAD", "x"], /<METHOD> must be one of/],
		[["POST", "x", "{"], /not valid JSON/],
		[["POST", "x", `${maxBody} `], /at most 65536 bytes/],
		[["POST", "x", "{}", "extra"], /Unexpected argument: extra/],
		[["GET", "x", "--as", "nobody"], /--as must be/],
	] as const)
		assert.throws(() => parseApiOptions(argv), message);
});

test("demo:record options: spec names, single tests and the output file", () => {
	assert.deepEqual(parseDemoRecordOptions(["session"], root), {
		kind: "run",
		options: {
			spec: path.join("tests", "e2e", "session.spec.ts"),
			out: path.join(".wrangler", "recordings", "session.webm"),
		},
	});
	assert.deepEqual(
		parseDemoRecordOptions(
			["tests/e2e/smoke.spec.ts:12", "--out", "demo/smoke.webm"],
			root
		),
		{
			kind: "run",
			options: {
				spec: `${path.join("tests", "e2e", "smoke.spec.ts")}:12`,
				out: "demo/smoke.webm",
			},
		}
	);
	assert.equal(parseDemoVideoEnv(undefined), false);
	assert.equal(parseDemoVideoEnv("1"), true);
	assert.throws(() => parseDemoVideoEnv("yes"), /STACK_E2E_VIDEO/);
	for (const [argv, message] of [
		[[], /Give a spec/],
		[["nope"], /No spec "nope" in tests\/e2e\. Specs: .*session/],
		[["tests/e2e/organizations.ts"], /No spec/],
		// Escapes the checkout whatever its directory is named (CI checks out
		// into the-stack/the-stack, where "../the-stack/..." stays inside).
		[["../outside-checkout/tests/e2e/session.spec.ts"], /No spec/],
		[["session", "smoke"], /one spec at a time/],
		[["session", "--out", "demo.mp4"], /must end in \.webm/],
	] as const)
		assert.throws(() => parseDemoRecordOptions(argv, root), message);
});

test("proof options: one mode, its own flags, and a rev", () => {
	assert.deepEqual(parseProofOptions([]), {
		kind: "run",
		options: { mode: "run", skipE2e: false, keep: false },
	});
	assert.deepEqual(parseProofOptions(["--skip-e2e", "--keep"]), {
		kind: "run",
		options: { mode: "run", skipE2e: true, keep: true },
	});
	assert.deepEqual(parseProofOptions(["--check"]), {
		kind: "run",
		options: {
			mode: "check",
			rev: "HEAD",
			allowSkippedE2e: false,
			requireReviewsCount: 0,
		},
	});
	assert.deepEqual(
		parseProofOptions([
			"--check",
			"main~1",
			"--allow-skipped-e2e",
			"--require-reviews",
			"2",
		]),
		{
			kind: "run",
			options: {
				mode: "check",
				rev: "main~1",
				allowSkippedE2e: true,
				requireReviewsCount: 2,
			},
		}
	);
	assert.deepEqual(parseProofOptions(["--show", "abc123"]), {
		kind: "run",
		options: { mode: "show", rev: "abc123" },
	});
	assert.deepEqual(parseProofOptions(["--add-review", "r.json"]), {
		kind: "run",
		options: { mode: "add-review", rev: "HEAD", reviewFile: "r.json" },
	});
	assert.deepEqual(parseProofOptions(["-h"]), { kind: "help" });
	for (const [argv, message] of [
		[["--check", "--show"], /Choose one of --check, --show/],
		[["--check", "--skip-e2e"], /--skip-e2e only applies when running/],
		[["--show", "--keep"], /--keep only applies when running/],
		[["--allow-skipped-e2e"], /only applies with --check/],
		[["--check", "--require-reviews=-1"], /whole number/],
		[["--check", "--require-reviews", "33"], /at most 32/],
		[["--check", "a", "b"], /at most one rev/],
		[["HEAD~1"], /always runs on HEAD/],
		[["--add-review"], /argument missing/],
		[["--skip-e2e=yes"], /does not take an argument/],
		[["--chek"], /Unknown option '--chek'/],
	] as const)
		assert.throws(() => parseProofOptions(argv), message);
});

test("each CLI prints help with exit 0 and rejects bad arguments with exit 2", () => {
	for (const [name, args] of [
		["ci-wait.ts", ["--help"]],
		["ship.ts", ["-h"]],
		["dev-server.ts", ["--help"]],
		["testing/prepare-e2e.ts", ["--help"]],
		["admin-bootstrap.ts", ["--help"]],
		["shot.ts", ["--help"]],
		["api.ts", ["-h"]],
		["demo-record.ts", ["--help"]],
		["proof.ts", ["--help"]],
	] as const) {
		const help = runScript(name, args);
		assert.equal(help.status, 0, `${name}: ${help.stderr}`);
		assert.match(help.stdout, /^Usage:/);
	}
	assertUsageError(
		runScript("ci-wait.ts", ["--timeout", "Infinity"]),
		/whole number/
	);
	assertUsageError(runScript("ci-wait.ts", ["--timeout=0"]), /at least 1/);
	assertUsageError(runScript("ship.ts", []), /Missing <pr>/);
	assertUsageError(runScript("proof.ts", ["--chek"]), /--chek/);
	assertUsageError(
		runScript("proof.ts", ["--check", "--require-reviews", "x"]),
		/whole number/
	);
	assertUsageError(runScript("ship.ts", ["7", "--sqash"]), /--sqash/);
	assertUsageError(
		runScript("dev-server.ts", ["start", "--port", "abc"]),
		/--port/
	);
	assertUsageError(
		runScript("dev-server.ts", ["wait", "--timeout", "x"]),
		/whole number/
	);
	assertUsageError(
		runScript("dev-server.ts", ["restart"]),
		/Unknown command/
	);
	assertUsageError(
		runScript("testing/prepare-e2e.ts", ["now"]),
		/Unexpected argument/
	);
	assertUsageError(
		runScript("testing/prepare-e2e.ts", [], {
			env: { STACK_E2E_PORT: "80" },
		}),
		/STACK_E2E_PORT/
	);
	assertUsageError(
		runScript("admin-bootstrap.ts", ["--url", "https://app.company.com"], {
			env: { BOOTSTRAP_SECRET: "" },
		}),
		/Set BOOTSTRAP_SECRET/
	);
	assertUsageError(
		runScript("admin-bootstrap.ts", ["--url", "http://app.example.com"], {
			env: { BOOTSTRAP_SECRET: "s" },
		}),
		/must use https/
	);
	assertUsageError(
		runScript("admin-bootstrap.ts", ["--delivery", "sms"]),
		/--delivery must be response or email/
	);
	assertUsageError(
		runScript("create-admin-local.mjs", ["--emial", "a@b.c"]),
		/--emial/
	);
	assertUsageError(runScript("shot.ts", []), /at least one path/);
	assertUsageError(
		runScript("shot.ts", ["x", "--viewport", "huge"]),
		/--viewport/
	);
	assertUsageError(runScript("api.ts", ["GET"]), /method and a path/);
	assertUsageError(runScript("api.ts", ["POST", "x", "{"]), /JSON/);
	assertUsageError(runScript("demo-record.ts", []), /Give a spec/);
	assertUsageError(runScript("demo-record.ts", ["nope"]), /No spec/);
});

test("ship with default arguments parses and stops at the placeholder production origin", () => {
	const result = runScript("ship.ts", ["7"]);
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /Set deploymentCloudflare\.vars\.APP_URL/);
	assert.doesNotMatch(result.stderr, /Usage:|\n\s+at /);
});

test("dev:stop and dev:wait run with their defaults from a checkout without a server", (t) => {
	const directory = temporaryDirectory(t, "stack-dev-cli-");
	const stop = runScript("dev-server.ts", ["stop"], { cwd: directory });
	assert.equal(stop.status, 0, stop.stderr);
	assert.match(stop.stdout, /No dev server is running/);
	// Port 9 (discard) refuses connections on any normal machine.
	const wait = runScript("dev-server.ts", ["wait", "--timeout", "1"], {
		cwd: directory,
		env: { APP_URL: "http://127.0.0.1:9" },
	});
	assert.equal(wait.status, 1, wait.stderr);
	assert.match(
		wait.stderr,
		/Dev server at http:\/\/127\.0\.0\.1:9 was not healthy after 1\.\ds/
	);
});

// A fake gh on PATH stands in for GitHub: pending on the first poll, green on
// the second. With the #24 bug the default 30 ms deadline expired after the
// first poll; with a 30 minute default ci:wait polls again and passes.
test("ci:wait with default arguments keeps polling past the first pending result", (t) => {
	const bin = temporaryDirectory(t, "stack-fake-gh-");
	const counter = path.join(bin, "polls");
	const gh = path.join(bin, "gh");
	writeFileSync(
		gh,
		`#!${process.execPath}
const fs = require("node:fs");
const polls = fs.existsSync(${JSON.stringify(counter)}) ? Number(fs.readFileSync(${JSON.stringify(counter)}, "utf8")) : 0;
fs.writeFileSync(${JSON.stringify(counter)}, String(polls + 1));
const status = polls === 0 ? "in_progress" : "completed";
const run = { id: 1, name: "fast", status, conclusion: polls === 0 ? null : "success", app: { slug: "github-actions" } };
process.stdout.write(JSON.stringify({ total_count: 1, check_runs: [run] }));
`
	);
	chmodSync(gh, 0o755);
	const result = runScript("ci-wait.ts", [], {
		env: { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
	});
	assert.equal(result.status, 0, result.stderr);
	assert.match(
		result.stdout,
		/pending\s+fast[\s\S]*pass\s+fast[\s\S]*CI passed\./
	);
});

test("admin:bootstrap options: defaults, origins and malformed input", () => {
	const env = { BOOTSTRAP_SECRET: "secret" };
	assert.deepEqual(
		parseAdminBootstrapOptions([], env, "https://app.company.com/app"),
		{
			kind: "run",
			options: {
				origin: "https://app.company.com",
				delivery: "response",
				secret: "secret",
			},
		}
	);
	for (const url of [
		"http://localhost:4321",
		"http://127.0.0.1:8787",
		"https://x.company.com",
	])
		assert.equal(
			parseAdminBootstrapOptions(
				["--url", url, "--delivery", "email"],
				env,
				""
			).kind,
			"run",
			url
		);
	for (const [argv, message] of [
		[["--url", "ftp://x.company.com"], /must use https/],
		[["--url", "http://10.0.0.1"], /must use https/],
		[["--url", "nope"], /must be an origin/],
		[["--delivery", "both"], /--delivery/],
		[["extra"], /Unexpected argument/],
	] as const)
		assert.throws(
			() =>
				parseAdminBootstrapOptions(
					argv,
					env,
					"https://app.company.com"
				),
			message
		);
	assert.throws(
		() => parseAdminBootstrapOptions([], {}, "https://app.company.com"),
		/Set BOOTSTRAP_SECRET/
	);
});

test("admin:bootstrap with default arguments stops at the placeholder production origin", () => {
	const result = runScript("admin-bootstrap.ts", [], {
		env: { BOOTSTRAP_SECRET: "secret" },
	});
	assert.equal(result.status, 1, result.stderr);
	assert.match(result.stderr, /Set deploymentCloudflare\.vars\.APP_URL/);
	assert.doesNotMatch(result.stderr, /Usage:|\n\s+at /);
});

// The script runs as a subprocess against a local stand-in for the Worker
// endpoint, so the test covers argv, env, HTTP and the exit code together.
// spawnSync would block the stand-in's event loop, hence the async spawn.
test("admin:bootstrap prints the password once, then reports an already bootstrapped deployment", async (t) => {
	const received: { secret: string | undefined; body: string }[] = [];
	const server = createServer((request: IncomingMessage, response) => {
		let body = "";
		request.on("data", (chunk: Buffer) => (body += chunk.toString()));
		request.on("end", () => {
			const secret = request.headers["x-bootstrap-secret"];
			received.push({
				secret: typeof secret === "string" ? secret : undefined,
				body,
			});
			const first = received.length === 1;
			response.writeHead(first ? 200 : 409, {
				"content-type": "application/json",
			});
			response.end(
				JSON.stringify(
					first
						? {
								ok: true,
								status: "bootstrapped",
								credential: {
									email: "owner@company.com",
									password: "generated-password-0123456789",
								},
							}
						: { ok: true, status: "already_bootstrapped" }
				)
			);
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve)
	);
	t.after(() => server.close());
	// SAFETY: listen() on a TCP host always yields an AddressInfo.
	const { port } = server.address() as AddressInfo;
	function run() {
		return new Promise<{
			status: number | null;
			stdout: string;
			stderr: string;
		}>((resolve, reject) => {
			const child = spawn(
				process.execPath,
				[
					script("admin-bootstrap.ts"),
					"--url",
					`http://127.0.0.1:${port}`,
				],
				{
					cwd: root,
					env: { ...process.env, BOOTSTRAP_SECRET: "the-secret" },
				}
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on(
				"data",
				(chunk: Buffer) => (stdout += chunk.toString())
			);
			child.stderr.on(
				"data",
				(chunk: Buffer) => (stderr += chunk.toString())
			);
			child.on("error", reject);
			child.on("close", (status) => resolve({ status, stdout, stderr }));
		});
	}
	const first = await run();
	assert.equal(first.status, 0, first.stderr);
	assert.match(first.stdout, /Admin: +owner@company\.com/);
	assert.match(first.stdout, /Password: generated-password-0123456789/);
	assert.match(
		first.stdout,
		/Sign in: +http:\/\/127\.0\.0\.1:\d+\/app\/login/
	);
	assert.deepEqual(received[0], {
		secret: "the-secret",
		body: '{"delivery":"response"}',
	});
	const second = await run();
	assert.equal(second.status, 1);
	assert.match(second.stderr, /already bootstrapped/);
	assert.doesNotMatch(second.stdout, /Password/);
});

test("doctor warns that the template's production email cannot send and says what that disables", (t) => {
	const directory = temporaryDirectory(t, "stack-doctor-");
	const result = runScript("dev-doctor.mjs", [], { cwd: directory });
	assert.match(
		result.stdout,
		/WARN Production email is not configured: EMAIL_FROM uses the placeholder domain your-app\.example\./
	);
	assert.match(
		result.stdout,
		/invitations, password reset, email verification/
	);
	assert.match(result.stdout, /pnpm admin:bootstrap/);
	assert.match(result.stdout, /OK {3}Local email is log-only/);
});
