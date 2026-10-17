import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
	addReview,
	deriveResult,
	evaluateProof,
	parseProofRecord,
	parseProofReview,
	PROOF_CHECK_DEFAULTS,
	PROOF_NOTE_BYTES_MAX,
	PROOF_REVIEW_FILE_BYTES_MAX,
	PROOF_REVIEWS_MAX,
	type CurrentProofRecord,
	type ProofRecord,
	type ProofReview,
	type ProofStep,
} from "../../scripts/lib/proof.ts";

const commit = "c".repeat(40);
const tree = "d".repeat(40);
const nowIso = "2026-01-02T03:04:05.000Z";

function step(name: ProofStep["name"], status: ProofStep["status"]): ProofStep {
	return {
		name,
		command: ["pnpm", name],
		status,
		exitCode: status === "passed" ? 0 : null,
		durationMs: 10,
		logPath: null,
		logTail: "",
	};
}

function record(
	overrides: Partial<CurrentProofRecord> = {}
): CurrentProofRecord {
	return {
		schemaVersion: 2,
		tool: { name: "proof", version: "2.0.0" },
		commit,
		tree,
		result: "passed",
		startedAt: nowIso,
		finishedAt: nowIso,
		durationMs: 30,
		environment: {
			node: "v24",
			pnpm: "10",
			platform: "linux",
			arch: "x64",
		},
		steps: [
			step("install", "passed"),
			step("verify", "passed"),
			step("deploy", "passed"),
			step("e2e", "passed"),
		],
		reviews: [],
		...overrides,
	};
}

// A record `pnpm proof` wrote before the deploy step existed.
function v1Record(): ProofRecord {
	const { steps: _steps, ...fields } = record();
	return {
		...fields,
		schemaVersion: 1,
		tool: { name: "proof", version: "1.0.0" },
		steps: [
			step("install", "passed"),
			step("verify", "passed"),
			step("e2e", "passed"),
		],
	};
}

const review: ProofReview = {
	reviewer: "someone",
	kind: "human",
	verdict: "approve",
	summary: "Looks right.",
	at: nowIso,
};

test("proof records: the result is derived from the steps and validated on read", () => {
	assert.deepEqual(parseProofRecord(JSON.stringify(record())), record());
	assert.equal(
		deriveResult([
			step("install", "passed"),
			step("verify", "passed"),
			step("e2e", "skipped"),
		]),
		"passed"
	);
	for (const status of ["failed", "timed_out", "not_run"] as const)
		assert.equal(
			deriveResult([
				step("install", "passed"),
				step("verify", status),
				step("e2e", "passed"),
			]),
			"failed"
		);
	const failedVerify = record({
		steps: [
			step("install", "passed"),
			step("verify", "failed"),
			step("deploy", "not_run"),
			step("e2e", "not_run"),
		],
	});
	for (const [text, message] of [
		["not json", /not JSON/],
		[JSON.stringify(failedVerify), /result does not match/],
		[JSON.stringify({ ...record(), schemaVersion: 3 }), /schemaVersion/],
		// A current record must have the deploy step, a v1 record must not.
		[JSON.stringify({ ...v1Record(), schemaVersion: 2 }), /steps/],
		[JSON.stringify({ ...record(), schemaVersion: 1 }), /steps/],
		[JSON.stringify({ ...record(), tree: "HEAD" }), /tree/],
		[
			JSON.stringify(
				record({
					steps: [
						step("install", "passed"),
						step("deploy", "passed"),
						step("verify", "passed"),
						step("e2e", "passed"),
					],
				})
			),
			/in order/,
		],
		[
			JSON.stringify(
				record({
					steps: [
						step("install", "passed"),
						step("verify", "passed"),
						step("deploy", "skipped"),
						step("e2e", "passed"),
					],
				})
			),
			/only the e2e step may be skipped/,
		],
		[" ".repeat(PROOF_NOTE_BYTES_MAX + 1), /exceeds/],
	] as const)
		assert.throws(() => parseProofRecord(text), message);
	// Version 1 records still read, so --show works on older commits.
	assert.deepEqual(parseProofRecord(JSON.stringify(v1Record())), v1Record());
});

test("proof check: binds to commit and tree, rejects failures, skipped e2e and missing reviews", () => {
	const target = { commit, tree };
	assert.deepEqual(evaluateProof(record(), target, PROOF_CHECK_DEFAULTS), []);
	const reasons = (
		candidate: ProofRecord,
		options = PROOF_CHECK_DEFAULTS,
		against = target
	) => evaluateProof(candidate, against, options).join("\n");
	assert.match(
		reasons(record(), PROOF_CHECK_DEFAULTS, {
			commit: "e".repeat(40),
			tree,
		}),
		/not e{40}/
	);
	assert.match(
		reasons(record(), PROOF_CHECK_DEFAULTS, {
			commit,
			tree: "f".repeat(40),
		}),
		/tree d{40}/
	);
	const failed = record({
		result: "failed",
		steps: [
			step("install", "passed"),
			step("verify", "passed"),
			step("deploy", "timed_out"),
			step("e2e", "not_run"),
		],
	});
	assert.match(reasons(failed), /failed \(deploy timed_out\)/);
	// A passing v1 proof never built the deploy artifact.
	assert.match(reasons(v1Record()), /predates the deploy step/);
	assert.match(
		reasons(v1Record(), { allowSkippedE2e: true, requireReviewsCount: 0 }),
		/predates the deploy step/
	);
	const skipped = record({
		steps: [
			step("install", "passed"),
			step("verify", "passed"),
			step("deploy", "passed"),
			step("e2e", "skipped"),
		],
	});
	assert.match(reasons(skipped), /skipped e2e/);
	assert.equal(
		reasons(skipped, { allowSkippedE2e: true, requireReviewsCount: 0 }),
		""
	);
	const requireOne = { allowSkippedE2e: false, requireReviewsCount: 1 };
	assert.match(reasons(record(), requireOne), /0 approving review/);
	const rejected = addReview(record(), {
		...review,
		verdict: "changes_requested",
	});
	assert.match(reasons(rejected, requireOne), /0 approving review/);
	assert.equal(reasons(addReview(rejected, review), requireOne), "");
});

test("proof reviews: validated, bounded, and stamped when `at` is missing", () => {
	const { at: _at, ...withoutAt } = review;
	assert.deepEqual(
		parseProofReview(JSON.stringify(withoutAt), nowIso),
		review
	);
	assert.equal(
		parseProofReview(
			JSON.stringify({ ...review, at: "2025-05-05T00:00:00Z" }),
			nowIso
		).at,
		"2025-05-05T00:00:00Z"
	);
	for (const [text, message] of [
		["{", /not JSON/],
		[JSON.stringify({ ...review, kind: "bot" }), /kind/],
		[JSON.stringify({ ...review, verdict: "lgtm" }), /verdict/],
		[JSON.stringify({ ...review, reviewer: " " }), /reviewer/],
		[JSON.stringify({ ...review, extra: 1 }), /extra/],
		[JSON.stringify({ ...review, at: "yesterday" }), /at/],
		[" ".repeat(PROOF_REVIEW_FILE_BYTES_MAX + 1), /exceeds/],
	] as const)
		assert.throws(() => parseProofReview(text, nowIso), message);
	let full: ProofRecord = record();
	for (let index = 0; index < PROOF_REVIEWS_MAX; index++)
		full = addReview(full, review);
	assert.throws(() => addReview(full, review), /maximum/);
	assert.equal(parseProofRecord(JSON.stringify(full)).reviews.length, 32);
});

// The real `node scripts/proof.ts` against a tiny repository, with a fake
// pnpm on PATH so the steps finish in milliseconds.
const proofScript = path.join(process.cwd(), "scripts", "proof.ts");

const FAKE_PNPM = `#!/bin/sh
if [ "$1" = "--version" ]; then echo 10.0.0-fake; exit 0; fi
echo "$PWD $*" >> "$FAKE_PNPM_LOG"
echo "fake pnpm $*"
# Nothing ignored in the developer's checkout may reach the copy.
if [ -e .env ] || [ -e node_modules ]; then echo "reused local state"; exit 9; fi
if [ "$*" = "$FAKE_PNPM_FAIL" ]; then echo "boom"; exit 3; fi
if [ "$*" = "$FAKE_PNPM_HANG" ]; then sleep 60; fi
exit 0
`;

type Sandbox = {
	readonly repo: string;
	readonly scratch: string;
	readonly pnpmLog: string;
	readonly env: Record<string, string>;
};

function createSandbox(t: test.TestContext): Sandbox {
	const base = mkdtempSync(path.join(tmpdir(), "proof-test-"));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const repo = path.join(base, "repo");
	const scratch = path.join(base, "tmp");
	const bin = path.join(base, "bin");
	for (const directory of [repo, scratch, bin]) mkdirSync(directory);
	writeFileSync(path.join(bin, "pnpm"), FAKE_PNPM);
	chmodSync(path.join(bin, "pnpm"), 0o755);
	const gitConfig = path.join(base, "gitconfig");
	writeFileSync(gitConfig, "");
	const env = {
		PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
		TMPDIR: scratch,
		GIT_CONFIG_GLOBAL: gitConfig,
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_AUTHOR_NAME: "Proof Test",
		GIT_AUTHOR_EMAIL: "proof@example.test",
		GIT_COMMITTER_NAME: "Proof Test",
		GIT_COMMITTER_EMAIL: "proof@example.test",
		FAKE_PNPM_LOG: path.join(base, "pnpm.log"),
		FAKE_PNPM_FAIL: "",
		FAKE_PNPM_HANG: "",
	};
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: repo,
			env: { ...process.env, ...env },
		});
	git("init", "--quiet", "--initial-branch=main");
	writeFileSync(
		path.join(repo, ".gitignore"),
		".proof/\n.env\nnode_modules/\n"
	);
	writeFileSync(path.join(repo, "app.txt"), "hello\n");
	git("add", ".");
	git("commit", "--quiet", "-m", "initial");
	// Ignored local state that must not be copied.
	writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
	mkdirSync(path.join(repo, "node_modules"));
	return { repo, scratch, pnpmLog: env.FAKE_PNPM_LOG, env };
}

function proof(
	sandbox: Sandbox,
	args: readonly string[],
	env: Record<string, string> = {}
) {
	return spawnSync(process.execPath, [proofScript, ...args], {
		cwd: sandbox.repo,
		encoding: "utf8",
		env: { ...process.env, ...sandbox.env, ...env },
		timeout: 60_000,
	});
}

function gitIn(sandbox: Sandbox, args: readonly string[], input?: string) {
	return execFileSync("git", args, {
		cwd: sandbox.repo,
		encoding: "utf8",
		input,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...sandbox.env },
	}).trim();
}

const e2eStatus = (proved: ProofRecord) =>
	proved.steps.find((entry) => entry.name === "e2e")?.status;

function shownRecord(sandbox: Sandbox): ProofRecord {
	const result = proof(sandbox, ["--show"]);
	assert.equal(result.status, 0, result.stderr);
	return parseProofRecord(result.stdout);
}

test("pnpm proof at its boundary: refuses dirty trees, records, checks and cleans up", (t) => {
	const sandbox = createSandbox(t);
	const head = gitIn(sandbox, ["rev-parse", "HEAD"]);

	writeFileSync(path.join(sandbox.repo, "draft.txt"), "uncommitted\n");
	const dirty = proof(sandbox, []);
	assert.equal(dirty.status, 1, dirty.stdout);
	assert.match(dirty.stderr, /uncommitted or untracked changes/);
	assert.match(dirty.stderr, /draft\.txt/);
	rmSync(path.join(sandbox.repo, "draft.txt"));
	const missing = proof(sandbox, ["--check"]);
	assert.equal(missing.status, 1);
	assert.match(missing.stderr, /No proof for/);

	const passed = proof(sandbox, []);
	assert.equal(passed.status, 0, passed.stderr + passed.stdout);
	assert.match(passed.stdout, /Proof PASSED/);
	const passedRecord = shownRecord(sandbox);
	assert.equal(passedRecord.commit, head);
	assert.equal(
		passedRecord.tree,
		gitIn(sandbox, ["rev-parse", "HEAD^{tree}"])
	);
	assert.deepEqual(
		passedRecord.steps.map((entry) => entry.status),
		["passed", "passed", "passed", "passed"]
	);
	assert.equal(passedRecord.environment.pnpm, "10.0.0-fake");
	assert.match(passedRecord.steps[1].logTail, /fake pnpm verify/);
	assert.ok(
		existsSync(path.join(sandbox.repo, ".proof", head, "verify.log"))
	);
	const calls = readFileSync(sandbox.pnpmLog, "utf8").trim().split("\n");
	assert.deepEqual(
		calls.map((line) => line.split(" ").slice(1).join(" ")),
		["install --frozen-lockfile", "verify", "check:deploy", "test:e2e"]
	);
	const scratch = realpathSync(sandbox.scratch);
	for (const line of calls)
		assert.ok(line.startsWith(scratch), `ran outside the copy: ${line}`);
	assert.equal(proof(sandbox, ["--check"]).status, 0);

	const skipped = proof(sandbox, ["--skip-e2e"]);
	assert.equal(skipped.status, 0, skipped.stderr);
	// Overwritten, not appended: the note is still one record.
	assert.equal(e2eStatus(shownRecord(sandbox)), "skipped");
	const rejected = proof(sandbox, ["--check"]);
	assert.equal(rejected.status, 1);
	assert.match(rejected.stderr, /skipped e2e/);
	assert.equal(proof(sandbox, ["--check", "--allow-skipped-e2e"]).status, 0);

	const reviewFile = path.join(sandbox.scratch, "..", "review.json");
	writeFileSync(
		reviewFile,
		JSON.stringify({
			reviewer: "r",
			kind: "tool",
			verdict: "approve",
			summary: "ok",
		})
	);
	const reviewArgs = [
		"--check",
		"--allow-skipped-e2e",
		"--require-reviews",
		"1",
	];
	assert.equal(proof(sandbox, reviewArgs).status, 1);
	assert.equal(proof(sandbox, ["--add-review", reviewFile]).status, 0);
	assert.equal(proof(sandbox, reviewArgs).status, 0);
	assert.equal(e2eStatus(shownRecord(sandbox)), "skipped");

	const failed = proof(sandbox, [], { FAKE_PNPM_FAIL: "verify" });
	assert.equal(failed.status, 1);
	assert.match(failed.stdout, /Proof FAILED/);
	const failedRecord = shownRecord(sandbox);
	assert.equal(failedRecord.result, "failed");
	assert.deepEqual(
		failedRecord.steps.map((entry) => [entry.status, entry.exitCode]),
		[
			["passed", 0],
			["failed", 3],
			["not_run", null],
			["not_run", null],
		]
	);
	assert.equal(proof(sandbox, ["--check"]).status, 1);

	// A commit that cannot build its deploy artifact has no passing proof,
	// and e2e does not run after it.
	const undeployable = proof(sandbox, [], {
		FAKE_PNPM_FAIL: "check:deploy",
	});
	assert.equal(undeployable.status, 1);
	assert.deepEqual(
		shownRecord(sandbox).steps.map((entry) => [entry.name, entry.status]),
		[
			["install", "passed"],
			["verify", "passed"],
			["deploy", "failed"],
			["e2e", "not_run"],
		]
	);
	const undeployableCheck = proof(sandbox, ["--check"]);
	assert.equal(undeployableCheck.status, 1);
	assert.match(undeployableCheck.stderr, /deploy failed/);

	// A schema 1 note, as older commits carry, shows but does not pass.
	gitIn(
		sandbox,
		["notes", "--ref=refs/notes/proof", "add", "--force", "--file=-", head],
		JSON.stringify({
			...v1Record(),
			commit: head,
			tree: gitIn(sandbox, ["rev-parse", "HEAD^{tree}"]),
		})
	);
	assert.equal(shownRecord(sandbox).schemaVersion, 1);
	const v1Check = proof(sandbox, ["--check"]);
	assert.equal(v1Check.status, 1);
	assert.match(v1Check.stderr, /predates the deploy step/);

	assert.equal(proof(sandbox, []).status, 0);
	const tampered = { ...shownRecord(sandbox), tree: "0".repeat(40) };
	gitIn(
		sandbox,
		["notes", "--ref=refs/notes/proof", "add", "--force", "--file=-", head],
		JSON.stringify(tampered)
	);
	const tamperedCheck = proof(sandbox, ["--check"]);
	assert.equal(tamperedCheck.status, 1);
	assert.match(tamperedCheck.stderr, /tree 0{40}/);

	// Every temporary checkout was removed, and git forgot it.
	assert.deepEqual(readdirSync(sandbox.scratch), []);
	assert.equal(gitIn(sandbox, ["worktree", "list"]).split("\n").length, 1);
});

test("pnpm proof stops the step and removes the copy on SIGTERM", async (t) => {
	const sandbox = createSandbox(t);
	const child = spawn(process.execPath, [proofScript], {
		cwd: sandbox.repo,
		env: { ...process.env, ...sandbox.env, FAKE_PNPM_HANG: "verify" },
		stdio: "ignore",
	});
	const exited = once(child, "exit");
	const deadlineMs = Date.now() + 30_000;
	const verifyStarted = () =>
		existsSync(sandbox.pnpmLog) &&
		readFileSync(sandbox.pnpmLog, "utf8").includes(" verify");
	while (!verifyStarted()) {
		assert.ok(Date.now() < deadlineMs, "verify never started");
		await delay(50);
	}
	child.kill("SIGTERM");
	const [code] = await exited;
	assert.equal(code, 143);
	assert.deepEqual(readdirSync(sandbox.scratch), []);
	assert.equal(proof(sandbox, ["--check"]).status, 1);
});
