// `pnpm proof` verifies the committed HEAD, not the working tree: it refuses a
// dirty tree, checks HEAD out into a temporary detached worktree, runs
// `pnpm install --frozen-lockfile`, `pnpm verify` and `pnpm test:e2e` there,
// and records the outcome as a git note on the commit (refs/notes/proof).
// `--check`, `--show` and `--add-review` read and extend that note.
//
// A detached `git worktree` rather than `git archive`: the copy is a real
// checkout of the commit, so tools that ask git (the build's commit stamp,
// tooling tests) see the proved SHA, and it shares the object store instead
// of copying it. Nothing untracked or ignored (node_modules, .wrangler, .env,
// dist) exists in it.

import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import {
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseBoundedInteger,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import { stopProcessTree } from "./lib/local-server.ts";
import {
	addReview,
	checkProof,
	deriveResult,
	formatChanges,
	PROOF_GIT_TIMEOUT_MS,
	PROOF_LOG_TAIL_BYTES_MAX,
	PROOF_NOTES_REF,
	PROOF_REVIEW_FILE_BYTES_MAX,
	PROOF_REVIEWS_MAX,
	PROOF_SCHEMA_VERSION,
	PROOF_TOOL_VERSION,
	parseProofReview,
	type ProofRecord,
	type ProofStep,
	type ProofStepName,
	type ProofSteps,
	type ProofTarget,
	proofSummary,
	readProof,
	resolveTarget,
	WORKING_TREE_STATUS_ARGS,
	workingTreeChanges,
	writeProof,
} from "./lib/proof.ts";

// A cold install on a slow network or loaded machine.
export const PROOF_INSTALL_TIMEOUT_MS = 15 * 60_000;
// Lint, build, type checks and every non-browser suite.
export const PROOF_VERIFY_TIMEOUT_MS = 45 * 60_000;
// A cold production build plus the browser suite.
export const PROOF_E2E_TIMEOUT_MS = 45 * 60_000;
export const PROOF_LOG_DIRECTORY = ".proof";

export const PROOF_USAGE = `Usage: pnpm proof [--skip-e2e] [--keep]
       pnpm proof --check [rev] [--allow-skipped-e2e] [--require-reviews <n>]
       pnpm proof --show [rev]
       pnpm proof --add-review <file.json> [rev]

Without a mode, verifies the committed HEAD in a clean temporary checkout
(install, pnpm verify, pnpm test:e2e) and records the result as a git note
under ${PROOF_NOTES_REF}. Refuses to run with uncommitted or untracked changes.
Logs go to ${PROOF_LOG_DIRECTORY}/<sha>/. pnpm ship pushes the note with the
commit (alone: git push origin ${PROOF_NOTES_REF}).

  --skip-e2e               Record e2e as skipped (--check rejects it by default).
  --keep                   Keep the temporary checkout and print its path.
  --check [rev]            Exit 0 only if rev (default HEAD) has a passing proof
                           of its exact tree with e2e run.
  --allow-skipped-e2e      With --check, accept a proof that skipped e2e.
  --require-reviews <n>    With --check, require n approving reviews (max ${PROOF_REVIEWS_MAX}).
  --show [rev]             Print rev's proof record.
  --add-review <file>      Append a review to rev's proof without rerunning it:
                           {"reviewer", "kind": "human"|"model"|"tool",
                            "verdict": "approve"|"changes_requested",
                            "summary", "at"?} (at most ${PROOF_REVIEW_FILE_BYTES_MAX} bytes).
  -h, --help               Show this help.`;

export type ProofOptions =
	| {
			readonly mode: "run";
			readonly skipE2e: boolean;
			readonly keep: boolean;
	  }
	| {
			readonly mode: "check";
			readonly rev: string;
			readonly allowSkippedE2e: boolean;
			readonly requireReviewsCount: number;
	  }
	| { readonly mode: "show"; readonly rev: string }
	| {
			readonly mode: "add-review";
			readonly rev: string;
			readonly reviewFile: string;
	  };

const PROOF_ARGS = {
	check: { type: "boolean" },
	show: { type: "boolean" },
	"add-review": { type: "string" },
	"skip-e2e": { type: "boolean" },
	keep: { type: "boolean" },
	"allow-skipped-e2e": { type: "boolean" },
	"require-reviews": { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;
type ProofArgs = ReturnType<
	typeof parseCommandLine<typeof PROOF_ARGS>
>["values"];

const MODE_FLAGS = ["check", "show", "add-review"] as const;
const RUN_FLAGS = ["skip-e2e", "keep"] as const;
const CHECK_FLAGS = ["allow-skipped-e2e", "require-reviews"] as const;

// One mode per invocation; flags of another mode are usage errors, not ignored.
function selectMode(values: ProofArgs): ProofOptions["mode"] {
	const modes = MODE_FLAGS.filter(
		(flag) => values[flag] !== undefined && values[flag] !== false
	);
	if (modes.length > 1)
		throw new UsageError(
			`Choose one of ${modes.map((mode) => `--${mode}`).join(", ")}.`
		);
	const mode = modes.at(0) ?? "run";
	const runFlag = RUN_FLAGS.find((flag) => values[flag] !== undefined);
	if (mode !== "run" && runFlag !== undefined)
		throw new UsageError(`--${runFlag} only applies when running a proof.`);
	const checkFlag = CHECK_FLAGS.find((flag) => values[flag] !== undefined);
	if (mode !== "check" && checkFlag !== undefined)
		throw new UsageError(`--${checkFlag} only applies with --check.`);
	return mode;
}

export function parseProofOptions(
	argv: readonly string[]
): Command<ProofOptions> {
	const { values, positionals } = parseCommandLine(argv, PROOF_ARGS);
	if (values.help === true) return { kind: "help" };
	const mode = selectMode(values);
	if (positionals.length > 1)
		throw new UsageError(
			`Expected at most one rev, got: ${positionals.join(" ")}.`
		);
	const rev = positionals[0] ?? "HEAD";
	if (rev === "") throw new UsageError("rev must not be empty.");
	switch (mode) {
		case "run":
			if (positionals.length > 0)
				throw new UsageError(
					`A proof always runs on HEAD; got "${rev}". Check out the commit first.`
				);
			return {
				kind: "run",
				options: {
					mode,
					skipE2e: values["skip-e2e"] === true,
					keep: values.keep === true,
				},
			};
		case "check": {
			const requireReviews = values["require-reviews"];
			const requireReviewsCount =
				requireReviews === undefined
					? 0
					: parseBoundedInteger(requireReviews, {
							name: "--require-reviews",
							min: 0,
							max: PROOF_REVIEWS_MAX,
						});
			const allowSkippedE2e = values["allow-skipped-e2e"] === true;
			return {
				kind: "run",
				options: { mode, rev, allowSkippedE2e, requireReviewsCount },
			};
		}
		case "show":
			return { kind: "run", options: { mode, rev } };
		case "add-review": {
			const reviewFile = values["add-review"];
			if (reviewFile === undefined || reviewFile === "")
				throw new UsageError("--add-review needs a file.");
			return { kind: "run", options: { mode, rev, reviewFile } };
		}
	}
}

function git(cwd: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: PROOF_GIT_TIMEOUT_MS,
	}).trim();
}

function repositoryRoot(): string {
	try {
		return git(process.cwd(), ["rev-parse", "--show-toplevel"]);
	} catch (error: unknown) {
		throw new CommandError("pnpm proof must run inside a git checkout.", {
			cause: error,
		});
	}
}

function assertClean(root: string): void {
	const changes = workingTreeChanges(git(root, WORKING_TREE_STATUS_ARGS));
	if (changes.length === 0) return;
	throw new CommandError(
		`The working tree has uncommitted or untracked changes, so a proof of HEAD would not\n` +
			`describe it. Commit or stash them, then rerun pnpm proof:\n${formatChanges(changes)}`
	);
}

type StepPlan = {
	readonly name: ProofStepName;
	readonly command: readonly [string, ...string[]];
	readonly timeoutMs: number;
};

const STEP_PLANS: readonly [StepPlan, StepPlan, StepPlan] = [
	{
		name: "install",
		command: ["pnpm", "install", "--frozen-lockfile"],
		timeoutMs: PROOF_INSTALL_TIMEOUT_MS,
	},
	{
		name: "verify",
		command: ["pnpm", "verify"],
		timeoutMs: PROOF_VERIFY_TIMEOUT_MS,
	},
	{
		name: "e2e",
		command: ["pnpm", "test:e2e"],
		timeoutMs: PROOF_E2E_TIMEOUT_MS,
	},
];

class Interrupted extends Error {}

type StepContext = {
	readonly root: string;
	readonly copy: string;
	readonly logDirectory: string;
	readonly env: NodeJS.ProcessEnv;
	readonly signal: AbortSignal;
};

function readTail(file: string): string {
	const sizeBytes = statSync(file).size;
	const lengthBytes = Math.min(sizeBytes, PROOF_LOG_TAIL_BYTES_MAX);
	const buffer = Buffer.alloc(lengthBytes);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buffer, 0, lengthBytes, sizeBytes - lengthBytes);
	} finally {
		closeSync(fd);
	}
	// A cut through a multi-byte character decodes to U+FFFD (3 bytes); trim
	// to stay within the bound.
	let tail = buffer.toString("utf8");
	while (Buffer.byteLength(tail) > PROOF_LOG_TAIL_BYTES_MAX)
		tail = tail.slice(1);
	return tail;
}

type Exit =
	| { readonly kind: "exited"; readonly exitCode: number | null }
	| { readonly kind: "timed_out" };

// Runs one step in its own process group; on timeout or interrupt the whole
// tree (pnpm, its scripts, servers they started) is stopped.
async function spawnStep(
	plan: StepPlan,
	context: StepContext,
	logFd: number
): Promise<Exit> {
	if (context.signal.aborted) throw new Interrupted();
	const [command, ...args] = plan.command;
	const child: ChildProcess = spawn(command, args, {
		cwd: context.copy,
		env: context.env,
		stdio: ["ignore", logFd, logFd],
		detached: true,
	});
	let timer: NodeJS.Timeout | undefined;
	let onAbort: (() => void) | undefined;
	const exited = new Promise<Exit>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", (code) =>
			resolve({ kind: "exited", exitCode: code })
		);
	});
	const stopped = new Promise<"timed_out" | "interrupted">((resolve) => {
		timer = setTimeout(() => resolve("timed_out"), plan.timeoutMs);
		onAbort = () => resolve("interrupted");
		context.signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const first = await Promise.race([exited, stopped]);
		if (typeof first !== "string") return first;
		if (child.pid !== undefined) await stopProcessTree(child.pid);
		if (first === "interrupted") throw new Interrupted();
		return { kind: "timed_out" };
	} finally {
		clearTimeout(timer);
		if (onAbort !== undefined)
			context.signal.removeEventListener("abort", onAbort);
	}
}

async function runStep(
	plan: StepPlan,
	context: StepContext
): Promise<ProofStep> {
	const logFile = path.join(context.logDirectory, `${plan.name}.log`);
	const logFd = openSync(logFile, "w");
	const relativeLog = path.relative(context.root, logFile);
	process.stdout.write(
		`-> ${plan.name}: ${plan.command.join(" ")} (log: ${relativeLog})\n`
	);
	const startedMs = performance.now();
	let exit: Exit;
	try {
		exit = await spawnStep(plan, context, logFd);
	} finally {
		closeSync(logFd);
	}
	const durationMs = Math.round(performance.now() - startedMs);
	const base = {
		command: plan.command,
		durationMs,
		logPath: relativeLog,
		logTail: readTail(logFile),
	};
	if (exit.kind === "timed_out")
		return {
			name: plan.name,
			...base,
			status: "timed_out",
			exitCode: null,
		};
	const status = exit.exitCode === 0 ? "passed" : "failed";
	return { name: plan.name, ...base, status, exitCode: exit.exitCode };
}

function unranStep(plan: StepPlan, status: "skipped" | "not_run"): ProofStep {
	return {
		name: plan.name,
		command: plan.command,
		status,
		exitCode: null,
		durationMs: 0,
		logPath: null,
		logTail: "",
	};
}

// A step runs only if the one before it (null: none) passed.
async function runAfter(
	previous: ProofStep | null,
	plan: StepPlan,
	context: StepContext
): Promise<ProofStep> {
	if (previous !== null && previous.status !== "passed")
		return unranStep(plan, "not_run");
	const step = await runStep(plan, context);
	process.stdout.write(
		`   ${step.name} ${step.status} in ${(step.durationMs / 1_000).toFixed(1)} s\n`
	);
	return step;
}

async function runSteps(
	context: StepContext,
	skipE2e: boolean
): Promise<ProofSteps> {
	const [installPlan, verifyPlan, e2ePlan] = STEP_PLANS;
	const install = await runAfter(null, installPlan, context);
	const verify = await runAfter(install, verifyPlan, context);
	const e2e =
		skipE2e && verify.status === "passed"
			? unranStep(e2ePlan, "skipped")
			: await runAfter(verify, e2ePlan, context);
	return [install, verify, e2e];
}

function createCopy(root: string, commit: string): string {
	const copy = mkdtempSync(path.join(tmpdir(), "proof-"));
	try {
		git(root, ["worktree", "add", "--detach", copy, commit]);
	} catch (error: unknown) {
		rmSync(copy, { recursive: true, force: true });
		throw error;
	}
	return copy;
}

// Synchronous so the signal path can use it too.
function removeCopy(root: string, copy: string): void {
	try {
		git(root, ["worktree", "remove", "--force", copy]);
	} catch (error: unknown) {
		// Already half-removed: delete the directory and drop the stale entry.
		process.stderr.write(
			`git worktree remove failed (${String(error)}); deleting ${copy}.\n`
		);
		rmSync(copy, { recursive: true, force: true });
		git(root, ["worktree", "prune"]);
	}
}

// The developer's node_modules/.bin (prepended by `pnpm proof`) must not
// shadow the copy's own binaries.
function stepEnv(root: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const inRepo = (entry: string) =>
		entry === root || entry.startsWith(`${root}${path.sep}`);
	env.PATH = (env.PATH ?? "")
		.split(path.delimiter)
		.filter((entry) => !inRepo(entry))
		.join(path.delimiter);
	// Each run claims its own e2e port.
	delete env.STACK_E2E_OWNER;
	return env;
}

function pnpmVersion(root: string): string {
	try {
		return execFileSync("pnpm", ["--version"], {
			cwd: root,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: PROOF_GIT_TIMEOUT_MS,
		}).trim();
	} catch (error: unknown) {
		throw new CommandError(`pnpm --version failed: ${String(error)}`, {
			cause: error,
		});
	}
}

type RunPrepared = {
	readonly root: string;
	readonly target: ProofTarget;
	readonly logDirectory: string;
};

function prepareRun(): RunPrepared {
	const root = repositoryRoot();
	assertClean(root);
	const target = resolveTarget("HEAD", root);
	const logDirectory = path.join(root, PROOF_LOG_DIRECTORY, target.commit);
	rmSync(logDirectory, { recursive: true, force: true });
	mkdirSync(logDirectory, { recursive: true });
	return { root, target, logDirectory };
}

// Runs the steps in a fresh copy of the commit and always removes it (unless
// --keep), including on failure, SIGINT and SIGTERM. null: interrupted.
async function runInCopy(
	run: RunPrepared,
	skipE2e: boolean,
	keep: boolean
): Promise<ProofSteps | null> {
	const copy = createCopy(run.root, run.target.commit);
	process.stdout.write(`Proving ${run.target.commit} in ${copy}\n`);
	const controller = new AbortController();
	const interrupt = (signal: NodeJS.Signals) => {
		process.stderr.write(
			`\n${signal}: stopping the current step and removing ${copy}.\n`
		);
		process.exitCode = signal === "SIGINT" ? 130 : 143;
		controller.abort();
	};
	process.on("SIGINT", interrupt);
	process.on("SIGTERM", interrupt);
	const env = stepEnv(run.root);
	const context = { ...run, copy, env, signal: controller.signal };
	try {
		return await runSteps(context, skipE2e);
	} catch (error: unknown) {
		if (error instanceof Interrupted) return null;
		throw error;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		if (keep)
			process.stdout.write(
				`Kept the checkout at ${copy}\nRemove it with: git worktree remove --force ${copy}\n`
			);
		else removeCopy(run.root, copy);
	}
}

async function runProof(skipE2e: boolean, keep: boolean): Promise<void> {
	const run = prepareRun();
	const pnpm = pnpmVersion(run.root);
	const startedAt = new Date();
	const startedMs = performance.now();
	const steps = await runInCopy(run, skipE2e, keep);
	if (steps === null) {
		// The copy is gone; keep the signal's exit code (130 or 143).
		process.stderr.write("Interrupted; no proof recorded.\n");
		process.exit();
	}
	const record: ProofRecord = {
		schemaVersion: PROOF_SCHEMA_VERSION,
		tool: { name: "proof", version: PROOF_TOOL_VERSION },
		commit: run.target.commit,
		tree: run.target.tree,
		result: deriveResult(steps),
		startedAt: startedAt.toISOString(),
		finishedAt: new Date().toISOString(),
		durationMs: Math.round(performance.now() - startedMs),
		environment: {
			node: process.version,
			pnpm,
			platform: process.platform,
			arch: process.arch,
		},
		steps,
		reviews: [],
	};
	writeProof(record, run.root);
	const logs = path.relative(run.root, run.logDirectory);
	process.stdout.write(`\n${proofSummary(record)}\n`);
	process.stdout.write(
		`Logs: ${logs}/\nNote: ${PROOF_NOTES_REF} (pnpm ship pushes it with the commit)\n`
	);
	if (record.result !== "passed")
		throw new CommandError("The proof failed; see the logs above.");
}

function check(
	rev: string,
	allowSkippedE2e: boolean,
	requireReviewsCount: number
): void {
	const result = checkProof(
		rev,
		{ allowSkippedE2e, requireReviewsCount },
		repositoryRoot()
	);
	if (result.record !== null)
		process.stdout.write(`${proofSummary(result.record)}\n`);
	if (!result.ok) throw new CommandError(result.reasons.join("\n"));
	process.stdout.write(`Proof OK for ${result.target.commit}.\n`);
}

function readExisting(rev: string, root: string): ProofRecord {
	const read = readProof(rev, root);
	switch (read.kind) {
		case "missing":
			throw new CommandError(`No proof for ${read.target.commit}.`);
		case "invalid":
			throw new CommandError(read.error);
		case "found":
			return read.record;
	}
}

function readReviewFile(file: string): string {
	try {
		if (statSync(file).size > PROOF_REVIEW_FILE_BYTES_MAX)
			throw new CommandError(
				`${file} exceeds ${PROOF_REVIEW_FILE_BYTES_MAX} bytes.`
			);
		return readFileSync(file, "utf8");
	} catch (error: unknown) {
		if (error instanceof CommandError) throw error;
		throw new CommandError(`Cannot read ${file}: ${String(error)}`, {
			cause: error,
		});
	}
}

function addReviewTo(rev: string, reviewFile: string): void {
	const root = repositoryRoot();
	const record = readExisting(rev, root);
	const review = parseProofReview(
		readReviewFile(reviewFile),
		new Date().toISOString()
	);
	const updated = addReview(record, review);
	writeProof(updated, root);
	process.stdout.write(
		`Added a ${review.verdict} review by ${review.reviewer}.\n${proofSummary(updated)}\n`
	);
}

export async function proof(options: ProofOptions): Promise<void> {
	switch (options.mode) {
		case "run":
			return runProof(options.skipE2e, options.keep);
		case "check":
			return check(
				options.rev,
				options.allowSkippedE2e,
				options.requireReviewsCount
			);
		case "show":
			process.stdout.write(
				`${JSON.stringify(readExisting(options.rev, repositoryRoot()), null, "\t")}\n`
			);
			return;
		case "add-review":
			return addReviewTo(options.rev, options.reviewFile);
	}
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: PROOF_USAGE,
		parse: () => parseProofOptions(process.argv.slice(2)),
		run: proof,
	});
