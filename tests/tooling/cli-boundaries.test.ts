import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test("each CLI prints help with exit 0 and rejects bad arguments with exit 2", () => {
	for (const [name, args] of [
		["ci-wait.ts", ["--help"]],
		["ship.ts", ["-h"]],
		["dev-server.ts", ["--help"]],
		["testing/prepare-e2e.ts", ["--help"]],
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
		runScript("create-admin-local.mjs", ["--emial", "a@b.c"]),
		/--emial/
	);
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
