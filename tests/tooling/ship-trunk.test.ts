import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ReleaseIo } from "../../scripts/ci-wait.ts";
import {
	parseProofRecord,
	PROOF_NOTES_REF,
	type CurrentProofRecord,
	type ProofRecord,
	type ProofStep,
	resolveTarget,
	writeProof,
} from "../../scripts/lib/proof.ts";
import { parseRemoteRefs } from "../../scripts/lib/trunk.ts";
import {
	LIVE_WAIT_TIMEOUT_MS_DEFAULT,
	ship,
	type TrunkShipOptions,
} from "../../scripts/ship.ts";

// Methodology: origin is a real bare repository and the checkout a real clone,
// so preconditions, the notes merge and the atomic push run real git. Only the
// deploy (pnpm, node scripts/deploy.mjs) and production's HTTP are faked: the
// fake deploy makes production serve its STACK_COMMIT.

const SHIP_SCRIPT = path.resolve(import.meta.dirname, "../../scripts/ship.ts");
const GIT_TIMEOUT_MS = 30_000;
const nowIso = "2026-01-02T03:04:05.000Z";
const config = {
	vars: {
		APP_URL: "https://app.test.dev/",
		ADMIN_EMAIL: "admin@app.test.dev",
	},
};
const trunk: TrunkShipOptions = {
	mode: "trunk",
	requireReviewsCount: 0,
	dryRun: false,
	liveTimeoutMs: LIVE_WAIT_TIMEOUT_MS_DEFAULT,
};

function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: GIT_TIMEOUT_MS,
	}).trim();
}

function configure(repo: string): void {
	git(repo, "config", "user.name", "Test");
	git(repo, "config", "user.email", "test@example.com");
	git(repo, "config", "commit.gpgsign", "false");
}

function commitFile(repo: string, name: string, text: string): string {
	writeFileSync(path.join(repo, name), text);
	git(repo, "add", name);
	git(repo, "commit", "--quiet", "-m", `Add ${name}`);
	return git(repo, "rev-parse", "HEAD");
}

function step(name: ProofStep["name"], status: ProofStep["status"]): ProofStep {
	return {
		name,
		command: ["pnpm", name],
		status,
		exitCode: status === "passed" ? 0 : 1,
		durationMs: 10,
		logPath: null,
		logTail: "",
	};
}

function prove(
	repo: string,
	rev: string,
	overrides: Partial<CurrentProofRecord> = {}
): void {
	const target = resolveTarget(rev, repo);
	writeProof(
		{
			schemaVersion: 2,
			tool: { name: "proof", version: "2.0.0" },
			commit: target.commit,
			tree: target.tree,
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
		},
		repo
	);
}

type Repos = {
	readonly directory: string;
	readonly origin: string;
	readonly work: string;
	readonly base: string;
	readonly head: string;
};

// origin/main at `base`; the checkout one proved commit (`head`) ahead.
function setup(t: test.TestContext): Repos {
	const directory = mkdtempSync(path.join(tmpdir(), "stack-ship-trunk-"));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const origin = path.join(directory, "origin.git");
	const work = path.join(directory, "work");
	git(directory, "init", "--quiet", "--bare", "-b", "main", origin);
	git(directory, "init", "--quiet", "-b", "main", work);
	configure(work);
	git(work, "remote", "add", "origin", origin);
	const base = commitFile(work, "a.txt", "a\n");
	git(work, "push", "--quiet", "origin", "main");
	const head = commitFile(work, "b.txt", "b\n");
	prove(work, "HEAD");
	return { directory, origin, work, base, head };
}

function cloneOf(repos: Repos, name: string): string {
	const clone = path.join(repos.directory, name);
	git(repos.directory, "clone", "--quiet", repos.origin, clone);
	configure(clone);
	return clone;
}

function remoteRef(repos: Repos, ref: string): string | null {
	const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", ref], {
		cwd: repos.origin,
		encoding: "utf8",
	});
	return result.status === 0 ? result.stdout.trim() : null;
}

function remoteNote(repos: Repos, commit: string): ProofRecord {
	return parseProofRecord(
		git(repos.origin, "notes", `--ref=${PROOF_NOTES_REF}`, "show", commit)
	);
}

function refsSnapshot(repo: string): string {
	return git(repo, "for-each-ref", "--format=%(refname) %(objectname)");
}

// git runs for real in the checkout; pnpm/node are recorded and succeed.
function trunkIo(
	work: string,
	servedAtStart: string | null,
	readiness: unknown = {}
) {
	const calls: string[] = [];
	const lines: string[] = [];
	const deployCommits: string[] = [];
	let served = servedAtStart;
	let clockMs = 0;
	const io: ReleaseIo & {
		calls: string[];
		lines: string[];
		deployCommits: string[];
	} = {
		calls,
		lines,
		deployCommits,
		exec(command, args, options) {
			calls.push([command, ...args].join(" "));
			if (command !== "git") {
				const commit = options.env?.STACK_COMMIT;
				if (commit !== undefined) {
					deployCommits.push(commit);
					served = commit;
				}
				return { status: 0, stdout: "", stderr: "" };
			}
			const result = spawnSync("git", args, {
				cwd: work,
				encoding: "utf8",
				timeout: GIT_TIMEOUT_MS,
			});
			return {
				status: result.status ?? 1,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		},
		async fetch(url) {
			calls.push(`fetch ${url}`);
			if (url.endsWith("/api/readiness")) return Response.json(readiness);
			return Response.json({ ok: true, commit: served, version: "v-1" });
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

const pushed = (io: { calls: string[] }) =>
	io.calls.some((call) => call.startsWith("git push"));

test("trunk ship pushes HEAD and its proof note atomically, deploys it and waits until live", async (t) => {
	const repos = setup(t);
	const io = trunkIo(repos.work, repos.base);
	await ship(io, trunk, config);
	assert.equal(remoteRef(repos, "refs/heads/main"), repos.head);
	assert.equal(remoteNote(repos, repos.head).commit, repos.head);
	assert.ok(
		io.calls.includes(
			`git push --atomic origin ${repos.head}:refs/heads/main ${PROOF_NOTES_REF}:${PROOF_NOTES_REF}`
		)
	);
	assert.deepEqual(io.deployCommits, [repos.head]);
	const deploy = io.calls.indexOf("node scripts/deploy.mjs");
	assert.ok(
		deploy > io.calls.findIndex((call) => call.startsWith("git push"))
	);
	const output = io.lines.join("\n");
	assert.match(output, /ok {4}proof: passing proof of tree/);
	assert.match(output, /Shipped main at [0-9a-f]{12} \(Worker version v-1\)/);
	assert.match(output, /Sign in:\s+https:\/\/app\.test\.dev\/app\/login/);
	assert.ok(!io.calls.some((call) => call.startsWith("gh ")));
});

test("trunk ship warns, without failing, while production's last email send failed", async (t) => {
	const repos = setup(t);
	const io = trunkIo(repos.work, repos.base, {
		ok: true,
		email: {
			delivery: "provider",
			transport: "cloudflare",
			lastSend: {
				outcome: "failed",
				atMs: Date.parse(nowIso),
				code: "E_SENDER_DOMAIN_NOT_AVAILABLE",
			},
		},
	});
	await ship(io, trunk, config);
	const output = io.lines.join("\n");
	assert.match(output, /Shipped main at/);
	assert.match(
		output,
		/WARN: the last email send failed at 2026-01-02T03:04:05\.000Z \(E_SENDER_DOMAIN_NOT_AVAILABLE\)/
	);
});

test("trunk ship refuses a dirty tree before any side effect", async (t) => {
	const repos = setup(t);
	writeFileSync(path.join(repos.work, "scratch.txt"), "x\n");
	const io = trunkIo(repos.work, repos.base);
	await assert.rejects(ship(io, trunk, config), /Fix the FAIL lines/);
	assert.match(
		io.lines.join("\n"),
		/FAIL {2}clean tree: .*\n.*\?\? scratch\.txt/
	);
	assert.ok(!pushed(io));
	assert.deepEqual(io.deployCommits, []);
	assert.equal(remoteRef(repos, "refs/heads/main"), repos.base);
});

test("trunk ship refuses a missing proof, a failed proof and a proof of another tree", async (t) => {
	const repos = setup(t);
	const cases: Array<[() => void, RegExp]> = [
		[
			() =>
				git(
					repos.work,
					"notes",
					`--ref=${PROOF_NOTES_REF}`,
					"remove",
					"HEAD"
				),
			/FAIL {2}proof: No proof for/,
		],
		[
			() =>
				prove(repos.work, "HEAD", {
					result: "failed",
					steps: [
						step("install", "passed"),
						step("verify", "failed"),
						step("deploy", "not_run"),
						step("e2e", "not_run"),
					],
				}),
			/FAIL {2}proof: The proof failed \(verify failed\)/,
		],
		[
			() =>
				prove(repos.work, "HEAD", {
					tree: resolveTarget(repos.base, repos.work).tree,
				}),
			/FAIL {2}proof: The proof is for tree [0-9a-f]+, but the commit has tree/,
		],
	];
	for (const [arrange, message] of cases) {
		arrange();
		const io = trunkIo(repos.work, repos.base);
		await assert.rejects(ship(io, trunk, config), /Nothing was pushed/);
		const output = io.lines.join("\n");
		assert.match(output, message);
		assert.match(output, /Run pnpm proof on this commit/);
		assert.ok(!pushed(io));
		assert.deepEqual(io.deployCommits, []);
	}
	assert.equal(remoteRef(repos, "refs/heads/main"), repos.base);
	assert.equal(remoteRef(repos, PROOF_NOTES_REF), null);
});

test("trunk ship refuses when main moved and pushes nothing", async (t) => {
	const repos = setup(t);
	const other = cloneOf(repos, "other");
	const moved = commitFile(other, "c.txt", "c\n");
	git(other, "push", "--quiet", "origin", "main");
	const io = trunkIo(repos.work, repos.base);
	await assert.rejects(ship(io, trunk, config), /Nothing was pushed/);
	assert.match(
		io.lines.join("\n"),
		/FAIL {2}fast-forward: origin main moved to [0-9a-f]{12}.*git rebase origin\/main.*rerun pnpm proof \(the proof is bound to the exact tree\)/s
	);
	assert.ok(!pushed(io));
	assert.equal(remoteRef(repos, "refs/heads/main"), moved);
	assert.equal(remoteRef(repos, PROOF_NOTES_REF), null);
});

test("trunk ship merges diverged remote notes and keeps one valid note per commit", async (t) => {
	const repos = setup(t);
	// Another checkout proved the base commit and pushed only its notes; both
	// sides also noted `base`, so the merge must pick one record, not concatenate.
	const other = cloneOf(repos, "other");
	prove(other, repos.base, { durationMs: 111 });
	const otherOnly = commitFile(other, "c.txt", "c\n");
	prove(other, otherOnly);
	git(other, "push", "--quiet", "origin", PROOF_NOTES_REF);
	prove(repos.work, repos.base, { durationMs: 222 });
	const io = trunkIo(repos.work, repos.base);
	await ship(io, trunk, config);
	assert.equal(remoteRef(repos, "refs/heads/main"), repos.head);
	assert.equal(remoteNote(repos, repos.head).commit, repos.head);
	assert.equal(remoteNote(repos, otherOnly).commit, otherOnly);
	// Strategy ours: the local record for the commit both sides noted.
	assert.equal(remoteNote(repos, repos.base).durationMs, 222);
	assert.equal(remoteRef(repos, "refs/notes/proof-incoming"), null);
	assert.equal(
		spawnSync(
			"git",
			["rev-parse", "--verify", "--quiet", "refs/notes/proof-incoming"],
			{
				cwd: repos.work,
			}
		).status,
		1
	);
});

test("trunk ship rerun after landing skips the push, and skips the deploy once live", async (t) => {
	const repos = setup(t);
	// First run lands, but production never serves the commit (deploy failed).
	const failing = trunkIo(repos.work, repos.base);
	failing.exec = ((exec) => (command, args, options) => {
		if (command === "node")
			return { status: 1, stdout: "", stderr: "deploy failed" };
		return exec(command, args, options);
	})(failing.exec);
	await assert.rejects(
		ship(failing, trunk, config),
		/node scripts\/deploy\.mjs exited with 1/
	);
	assert.ok(pushed(failing));
	assert.equal(remoteRef(repos, "refs/heads/main"), repos.head);

	const resume = trunkIo(repos.work, repos.base);
	await ship(resume, trunk, config);
	assert.ok(!pushed(resume));
	assert.match(resume.lines.join("\n"), /skipping the push/);
	assert.deepEqual(resume.deployCommits, [repos.head]);

	const live = trunkIo(repos.work, repos.head);
	await ship(live, trunk, config);
	assert.ok(!pushed(live));
	assert.deepEqual(live.deployCommits, []);
	assert.ok(!live.calls.includes("pnpm install --frozen-lockfile"));
});

test("trunk ship skips the deploy when production already serves the commit", async (t) => {
	const repos = setup(t);
	const io = trunkIo(repos.work, repos.head);
	await ship(io, trunk, config);
	assert.ok(pushed(io));
	assert.deepEqual(io.deployCommits, []);
	assert.match(
		io.lines.join("\n"),
		/already serves [0-9a-f]{12}; skipping the deploy/
	);
});

test("trunk ship --dry-run prints the preconditions and plan and changes nothing", async (t) => {
	const repos = setup(t);
	const other = cloneOf(repos, "other");
	prove(other, repos.base);
	git(other, "push", "--quiet", "origin", PROOF_NOTES_REF);
	const before = [refsSnapshot(repos.work), refsSnapshot(repos.origin)];
	const io = trunkIo(repos.work, repos.base);
	await ship(io, { ...trunk, dryRun: true }, config);
	assert.deepEqual(
		[refsSnapshot(repos.work), refsSnapshot(repos.origin)],
		before
	);
	assert.ok(
		io.calls.every(
			(call) =>
				!/^git (push|fetch|notes|update-ref)|^pnpm|^node/.test(call)
		)
	);
	const output = io.lines.join("\n");
	for (const name of [
		"clean tree",
		"proof",
		"fast-forward",
		"production origin",
	])
		assert.match(output, new RegExp(`ok {4}${name}: `));
	assert.match(
		output,
		/1\. fetch origin's refs\/notes\/proof .* merge it \(strategy ours\)/
	);
	assert.match(
		output,
		/2\. git push --atomic origin [0-9a-f]{40}:refs\/heads\/main/
	);
	assert.match(
		output,
		/node scripts\/deploy\.mjs \(STACK_COMMIT=[0-9a-f]{40}\)/
	);

	writeFileSync(path.join(repos.work, "scratch.txt"), "x\n");
	const blocked = trunkIo(repos.work, repos.base);
	await assert.rejects(
		ship(
			blocked,
			{ ...trunk, dryRun: true },
			{ vars: { ...config.vars, APP_URL: "https://x.example" } }
		),
		/A ship would stop here/
	);
	const blockedOutput = blocked.lines.join("\n");
	assert.match(blockedOutput, /FAIL {2}clean tree/);
	assert.match(blockedOutput, /FAIL {2}production origin/);
	assert.match(blockedOutput, /ok {4}proof/);
});

test("trunk ship --require-reviews counts approving reviews on the proof", async (t) => {
	const repos = setup(t);
	const io = trunkIo(repos.work, repos.base);
	await assert.rejects(
		ship(io, { ...trunk, requireReviewsCount: 1 }, config),
		/Nothing was pushed/
	);
	assert.match(io.lines.join("\n"), /0 approving review\(s\); 1 required/);
	assert.ok(!pushed(io));
});

test("git ls-remote output parses into origin's main and notes heads", () => {
	const main = "1".repeat(40);
	const notes = "2".repeat(40);
	assert.deepEqual(
		parseRemoteRefs(
			`${main}\trefs/heads/main\n${notes}\trefs/notes/proof\n`
		),
		{ mainSha: main, notesSha: notes }
	);
	assert.deepEqual(parseRemoteRefs(""), { mainSha: null, notesSha: null });
	assert.throws(
		() => parseRemoteRefs("nope\trefs/heads/main"),
		/Unexpected git ls-remote line/
	);
});

// The real entry point, as a user runs it: help, bad arguments, and --dry-run
// in a temporary checkout. The template's APP_URL is a placeholder, so the dry
// run reports that precondition and exits 1 after printing the full plan.
test("node scripts/ship.ts: help, bad arguments and --dry-run in a proved checkout", (t) => {
	const repos = setup(t);
	const run = (args: string[]) =>
		spawnSync(process.execPath, [SHIP_SCRIPT, ...args], {
			cwd: repos.work,
			encoding: "utf8",
			timeout: 60_000,
		});
	const help = run(["--help"]);
	assert.equal(help.status, 0, help.stderr);
	assert.match(help.stdout, /^Usage: pnpm ship \[--dry-run\]/);
	assert.ok(
		help.stdout.indexOf("Trunk (default") <
			help.stdout.indexOf("Pull request (<pr>")
	);

	const bad = run(["--dry-run", "7"]);
	assert.equal(bad.status, 2);
	assert.match(bad.stderr, /--dry-run only applies to trunk mode/);

	const before = [refsSnapshot(repos.work), refsSnapshot(repos.origin)];
	const dryRun = run(["--dry-run"]);
	assert.equal(dryRun.status, 1, dryRun.stderr);
	assert.match(dryRun.stdout, new RegExp(`Dry run for ${repos.head}`));
	assert.match(dryRun.stdout, /ok {4}clean tree/);
	assert.match(dryRun.stdout, /ok {4}proof: passing proof/);
	assert.match(
		dryRun.stdout,
		/ok {4}fast-forward: origin main [0-9a-f]{12} is an ancestor of HEAD/
	);
	assert.match(
		dryRun.stdout,
		/FAIL {2}production origin: Set deploymentCloudflare\.vars\.APP_URL/
	);
	assert.match(dryRun.stderr, /A ship would stop here/);
	assert.deepEqual(
		[refsSnapshot(repos.work), refsSnapshot(repos.origin)],
		before
	);
});

test("CI audits main's HEAD for a passing proof on push, and leaves PR jobs alone", () => {
	const ci = readFileSync(
		path.resolve(import.meta.dirname, "../../.github/workflows/ci.yml"),
		"utf8"
	);
	const fullJob = ci.slice(ci.indexOf("\n    full:"));
	const fastJob = ci.slice(
		ci.indexOf("\n    fast:"),
		ci.indexOf("\n    full:")
	);
	assert.match(fullJob, /if: github\.event_name == 'push'/);
	assert.match(
		fullJob,
		/git fetch --no-tags origin "\+refs\/notes\/proof:refs\/notes\/proof"/
	);
	assert.match(fullJob, /pnpm proof --check HEAD/);
	// PR-based repositories need a way out of the trunk audit.
	assert.match(fullJob, /vars\.STACK_PROOF_AUDIT != 'off'/);
	assert.doesNotMatch(fastJob, /proof/);
});
