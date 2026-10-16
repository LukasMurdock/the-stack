import assert from "node:assert/strict";
import test from "node:test";
import { buildCommit } from "../../scripts/lib/build-commit.ts";
import {
	type CheckRun,
	mergeAction,
	parseCheckRuns,
	parseTarget,
	productionOrigin,
	summarizeChecks,
} from "../../scripts/lib/release.ts";
import {
	CI_POLL_INTERVAL_MS,
	CI_WAIT_TIMEOUT_MS_DEFAULT,
	type ReleaseIo,
	waitForChecks,
} from "../../scripts/ci-wait.ts";
import {
	LIVE_WAIT_TIMEOUT_MS_DEFAULT,
	ship,
	type ShipOptions,
} from "../../scripts/ship.ts";

type Result = { status: number; stdout: string; stderr: string };
type Handler = string | ((args: string[]) => Result | string);

const ok = (stdout = ""): Result => ({ status: 0, stdout, stderr: "" });
const sha = "a".repeat(40);
const mergeSha = "b".repeat(40);
const ciTiming = {
	ciTimeoutMs: CI_WAIT_TIMEOUT_MS_DEFAULT,
	pollIntervalMs: CI_POLL_INTERVAL_MS,
};
const shipOptions: ShipOptions = {
	pullRequestNumber: 7,
	mergeMethod: "merge",
	ciTimeoutMs: CI_WAIT_TIMEOUT_MS_DEFAULT,
	liveTimeoutMs: LIVE_WAIT_TIMEOUT_MS_DEFAULT,
};
const config = {
	vars: {
		APP_URL: "https://app.test.dev/",
		ADMIN_EMAIL: "admin@app.test.dev",
	},
};

function run(
	name: string,
	status: string,
	conclusion: string | null,
	job = 1
): CheckRun {
	return {
		name,
		status,
		conclusion,
		app: { slug: "github-actions" },
		html_url: `https://github.com/o/r/actions/runs/9/job/${job}`,
	};
}

// gh/git/pnpm/node and production fetches are the external boundary: a fake
// records every command and answers from per-command handlers.
function fakeIo(
	handlers: Record<string, Handler>,
	health: Array<{ commit: string | null; version?: string } | null> = []
) {
	const calls: string[] = [];
	const lines: string[] = [];
	let clockMs = 0;
	const io: ReleaseIo & { calls: string[]; lines: string[] } = {
		calls,
		lines,
		exec(command, args) {
			const call = [command, ...args].join(" ");
			calls.push(call);
			const key = Object.keys(handlers)
				.sort((a, b) => b.length - a.length)
				.find((prefix) => call.startsWith(prefix));
			if (!key) return ok();
			const handler = handlers[key];
			if (handler === undefined) return ok();
			const result =
				typeof handler === "string" ? handler : handler([...args]);
			return typeof result === "string" ? ok(result) : result;
		},
		async fetch(url) {
			calls.push(`fetch ${url}`);
			if (url.endsWith("/api/readiness"))
				return new Response("{}", { status: 200 });
			const body = health.length > 1 ? health.shift() : health[0];
			return body
				? Response.json({ ok: true, ...body })
				: new Response("down", { status: 503 });
		},
		async sleep(durationMs) {
			clockMs += durationMs;
		},
		nowMs: () => clockMs,
		log(line) {
			lines.push(line);
		},
	};
	return io;
}

function checkRuns(...sequence: CheckRun[][]): Handler {
	return () => {
		const runs =
			(sequence.length > 1 ? sequence.shift() : sequence[0]) ?? [];
		return JSON.stringify({ total_count: runs.length, check_runs: runs });
	};
}

function prView(...states: string[]): Handler {
	return () => {
		const state =
			(states.length > 1 ? states.shift() : states[0]) ?? "OPEN";
		return JSON.stringify({
			number: 7,
			title: "Feature",
			url: "https://github.com/o/r/pull/7",
			state,
			isDraft: false,
			baseRefName: "main",
			headRefOid: sha,
			mergeCommit: state === "MERGED" ? { oid: mergeSha } : null,
		});
	};
}

test("check verdicts stay pending until every run finishes and fail on any bad conclusion", () => {
	assert.equal(summarizeChecks([]).state, "pending");
	assert.equal(
		summarizeChecks([
			run("fast", "completed", "success"),
			run("full", "in_progress", null),
		]).state,
		"pending"
	);
	assert.equal(
		summarizeChecks([
			run("fast", "completed", "success"),
			run("full", "completed", "skipped"),
		]).state,
		"passed"
	);
	const failed = summarizeChecks([
		run("fast", "completed", "cancelled", 42),
		{ ...run("external", "completed", "failure"), app: { slug: "other" } },
	]).failed;
	assert.deepEqual(
		failed.map((check) => [check.name, check.jobId]),
		[
			["external", null],
			["fast", "42"],
		]
	);
	// A re-run supersedes the failed attempt; both stay on the commit.
	assert.equal(
		summarizeChecks([
			{ ...run("fast", "completed", "failure"), id: 1 },
			{ ...run("fast", "completed", "success"), id: 2 },
		]).state,
		"passed"
	);
	assert.deepEqual(parseTarget(undefined), { kind: "ref", ref: "HEAD" });
	assert.deepEqual(parseTarget("#12"), { kind: "pr", number: 12 });
	assert.deepEqual(parseTarget("feature/x"), {
		kind: "ref",
		ref: "feature/x",
	});
});

test("ci:wait polls until checks pass, and reports failing jobs with log tails", async () => {
	const passing = fakeIo({
		"gh api": checkRuns(
			[],
			[run("fast", "queued", null)],
			[run("fast", "completed", "success")]
		),
	});
	assert.equal((await waitForChecks(passing, sha, ciTiming)).state, "passed");
	assert.equal(passing.calls.filter((c) => c.startsWith("gh api")).length, 3);
	assert.match(
		passing.calls[0] ?? "",
		/repos\/\{owner\}\/\{repo\}\/commits\/a+\/check-runs/
	);

	const failing = fakeIo({
		"gh api": checkRuns([run("fast", "completed", "failure", 77)]),
		"gh run view --job 77 --log-failed": [
			...Array.from(
				{ length: 60 },
				(_, i) => `fast\tTest\t2026-10-05T23:45:38.0599202Z line ${i}`
			),
			"fast\tTest\t2026-10-05T23:45:38.0599202Z ##[error]tests failed",
			"fast\tPost\t2026-10-05T23:45:39.0000000Z Post job cleanup.",
		].join("\n"),
	});
	await assert.rejects(
		waitForChecks(failing, sha, ciTiming),
		/CI failed: fast/
	);
	const output = failing.lines.join("\n");
	assert.match(output, /fail\s+fast \(failure\)/);
	assert.match(output, /^line 59\n##\[error\]tests failed$/m);
	assert.doesNotMatch(output, /line 0\n|cleanup/);

	const stuck = fakeIo({
		"gh api": checkRuns([run("fast", "in_progress", null)]),
	});
	await assert.rejects(
		waitForChecks(stuck, sha, {
			ciTimeoutMs: 60_000,
			pollIntervalMs: 10_000,
		}),
		/did not finish within 1 minutes/
	);
});

test("ship waits for CI, merges once, deploys, and confirms production serves the commit", async () => {
	const io = fakeIo(
		{
			"git status --porcelain": "",
			"gh pr view": prView("OPEN", "MERGED"),
			"gh api": checkRuns([run("fast", "completed", "success")]),
			"git rev-parse HEAD": mergeSha,
		},
		[
			{ commit: "old" },
			{ commit: "old" },
			{ commit: mergeSha, version: "v-new" },
			{ commit: "old" },
			{ commit: mergeSha, version: "v-new" },
		]
	);
	await ship(io, shipOptions, config);
	const commands = io.calls.filter((c) => !c.startsWith("fetch"));
	const merge = commands.findIndex((c) => c.startsWith("gh pr merge"));
	const deploy = commands.indexOf("node scripts/deploy.mjs");
	assert.equal(
		commands[merge],
		`gh pr merge 7 --merge --match-head-commit ${sha}`
	);
	assert.ok(commands.findIndex((c) => c.startsWith("gh api")) < merge);
	assert.ok(commands.indexOf("git merge --ff-only origin/main") > merge);
	assert.ok(deploy > commands.indexOf("git merge --ff-only origin/main"));
	// One stale response mid-rollout resets the consecutive-match count.
	assert.equal(
		io.calls.filter((c) => c === "fetch https://app.test.dev/api/health")
			.length,
		7
	);
	const output = io.lines.join("\n");
	assert.match(output, /Worker version v-new/);
	assert.match(output, /Sign in:\s+https:\/\/app\.test\.dev\/app\/login/);
	assert.match(output, /admin@app\.test\.dev/);
	assert.match(output, /pnpm admin:bootstrap/);
});

test("ship resumes a merged PR without merging again and skips a deploy already live", async () => {
	const handlers = {
		// Resource IDs a failed deploy recorded must not block the rerun.
		"git status --porcelain": " M void.lock.json",
		"gh pr view": prView("MERGED"),
		"git rev-parse HEAD": mergeSha,
	};
	const redeploy = fakeIo(handlers, [
		{ commit: "old" },
		{ commit: mergeSha },
	]);
	await ship(redeploy, shipOptions, config);
	assert.ok(!redeploy.calls.some((c) => c.startsWith("gh pr merge")));
	assert.ok(!redeploy.calls.some((c) => c.startsWith("gh api")));
	assert.ok(redeploy.calls.includes("node scripts/deploy.mjs"));

	const live = fakeIo(handlers, [{ commit: mergeSha }]);
	await ship(live, shipOptions, config);
	assert.ok(!live.calls.includes("node scripts/deploy.mjs"));
});

test("ship stops before production changes when it cannot ship safely", async () => {
	const failedCi = fakeIo({
		"git status --porcelain": "",
		"gh pr view": prView("OPEN"),
		"gh api": checkRuns([run("fast", "completed", "failure")]),
	});
	await assert.rejects(ship(failedCi, shipOptions, config), /CI failed/);
	assert.ok(!failedCi.calls.some((c) => /gh pr merge|deploy\.mjs/.test(c)));

	const dirty = fakeIo({ "git status --porcelain": " M file.ts" });
	await assert.rejects(ship(dirty, shipOptions, config), /Commit or stash/);

	const notLive = fakeIo(
		{
			"git status --porcelain": "",
			"gh pr view": prView("MERGED"),
			"git rev-parse HEAD": mergeSha,
		},
		[{ commit: "old" }]
	);
	await assert.rejects(
		ship(notLive, { ...shipOptions, liveTimeoutMs: 30_000 }, config),
		/Production serves old; expected b+/
	);

	assert.throws(
		() => mergeAction({ number: 7, state: "CLOSED", isDraft: false }),
		/closed without merging/
	);
	assert.throws(
		() => productionOrigin("https://your-app.example"),
		/Set deploymentCloudflare\.vars\.APP_URL/
	);
});

test("the build commit comes from STACK_COMMIT or the checkout", () => {
	assert.equal(buildCommit({ STACK_COMMIT: sha }), sha);
	assert.match(buildCommit({}) ?? "", /^[0-9a-f]{40}$/);
});

test("ci:wait refuses to judge a commit whose check runs do not fit one page", () => {
	const page = [run("fast", "completed", "success")];
	assert.equal(
		parseCheckRuns(JSON.stringify({ total_count: 1, check_runs: page }))
			.length,
		1
	);
	assert.throws(
		() =>
			parseCheckRuns(
				JSON.stringify({ total_count: 101, check_runs: page })
			),
		/101 check runs; ci:wait reads at most 100/
	);
	assert.throws(() =>
		parseCheckRuns(JSON.stringify({ message: "Not Found" }))
	);
});

test("ship reports why production never served the commit", async () => {
	const unreachable = fakeIo({
		"git status --porcelain": "",
		"gh pr view": prView("MERGED"),
		"git rev-parse HEAD": mergeSha,
	});
	unreachable.fetch = async () => {
		throw new TypeError("fetch failed", {
			cause: new Error("getaddrinfo ENOTFOUND app.test.dev"),
		});
	};
	await assert.rejects(
		ship(unreachable, { ...shipOptions, liveTimeoutMs: 10_000 }, config),
		/Production serves no commit \(fetch failed: getaddrinfo ENOTFOUND app\.test\.dev\)/
	);
});

test("the build commit rejects a STACK_COMMIT that is not a full SHA", () => {
	assert.equal(buildCommit({ STACK_COMMIT: sha }), sha);
	assert.throws(
		() => buildCommit({ STACK_COMMIT: "abc123" }),
		/40-character/
	);
});
