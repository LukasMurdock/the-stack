// The proof record: evidence that one commit's exact tree passed install,
// `pnpm verify` and `pnpm test:e2e` in a clean copy. `pnpm proof` writes it as
// a git note under refs/notes/proof; `pnpm proof --check` and `pnpm ship` read
// it back here. A note is external input, so it is parsed with zod and bound
// to the commit and tree it claims to describe. Expected failures (bad input,
// unknown rev) are CommandErrors so the CLI prints them without a stack. It is self-attested evidence,
// not a security boundary: anyone who can push can write a note.

import { execFileSync } from "node:child_process";
import { z } from "zod";
import { CommandError, errorCode } from "./cli.ts";

export const PROOF_SCHEMA_VERSION = 1;
// Bumped when what a proof runs or records changes.
export const PROOF_TOOL_VERSION = "1.0.0";
export const PROOF_NOTES_REF = "refs/notes/proof";
// Keeps a record readable in `git notes show` and cheap to fetch.
export const PROOF_LOG_TAIL_BYTES_MAX = 4_096;
export const PROOF_REVIEWS_MAX = 32;
export const PROOF_REVIEW_SUMMARY_LENGTH_MAX = 2_000;
export const PROOF_REVIEW_FILE_BYTES_MAX = 16_384;
// Three log tails plus the full review allowance, with room to spare.
export const PROOF_NOTE_BYTES_MAX = 262_144;
// git answers in milliseconds; a hung filesystem must not block forever.
export const PROOF_GIT_TIMEOUT_MS = 30_000;

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const sha = z.string().regex(SHA_PATTERN);
const timestamp = z.iso.datetime();
const durationMs = z.number().int().nonnegative();

export const PROOF_STEP_NAMES = ["install", "verify", "e2e"] as const;
export type ProofStepName = (typeof PROOF_STEP_NAMES)[number];

// not_run: an earlier step failed, so this one never started.
const stepStatus = z.enum([
	"passed",
	"failed",
	"timed_out",
	"skipped",
	"not_run",
]);
export type ProofStepStatus = z.infer<typeof stepStatus>;

const stepSchema = z
	.object({
		name: z.enum(PROOF_STEP_NAMES),
		command: z.array(z.string().max(200)).min(1).max(8).readonly(),
		status: stepStatus,
		exitCode: z.number().int().nullable(),
		durationMs,
		logPath: z.string().max(500).nullable(),
		logTail: z.string().max(PROOF_LOG_TAIL_BYTES_MAX),
	})
	.readonly();
export type ProofStep = z.infer<typeof stepSchema>;

export const proofReviewSchema = z
	.object({
		reviewer: z.string().trim().min(1).max(200),
		kind: z.enum(["human", "model", "tool"]),
		verdict: z.enum(["approve", "changes_requested"]),
		summary: z.string().trim().min(1).max(PROOF_REVIEW_SUMMARY_LENGTH_MAX),
		at: timestamp,
	})
	.strict()
	.readonly();
export type ProofReview = z.infer<typeof proofReviewSchema>;

// A review file may leave out `at`; --add-review stamps the current time.
export const proofReviewInputSchema = proofReviewSchema
	.unwrap()
	.extend({ at: timestamp.optional() })
	.strict();

// Exactly install, verify, e2e, in that order.
const stepsSchema = z
	.tuple([stepSchema, stepSchema, stepSchema])
	.readonly()
	.refine(
		(steps) =>
			steps.every((step, index) => step.name === PROOF_STEP_NAMES[index]),
		{
			message: `steps must be ${PROOF_STEP_NAMES.join(", ")} in order`,
		}
	);
export type ProofSteps = z.infer<typeof stepsSchema>;

export const proofRecordSchema = z
	.object({
		schemaVersion: z.literal(PROOF_SCHEMA_VERSION),
		tool: z
			.object({ name: z.literal("proof"), version: z.string().max(50) })
			.readonly(),
		commit: sha,
		tree: sha,
		result: z.enum(["passed", "failed"]),
		startedAt: timestamp,
		finishedAt: timestamp,
		durationMs,
		environment: z
			.object({
				node: z.string().max(50),
				pnpm: z.string().max(50),
				platform: z.string().max(50),
				arch: z.string().max(50),
			})
			.readonly(),
		steps: stepsSchema,
		reviews: z.array(proofReviewSchema).max(PROOF_REVIEWS_MAX).readonly(),
	})
	.readonly()
	.refine((record) => record.result === deriveResult(record.steps), {
		message: "result does not match the step statuses",
		path: ["result"],
	})
	.refine(
		(record) =>
			record.steps[0].status !== "skipped" &&
			record.steps[1].status !== "skipped",
		{
			message: "only the e2e step may be skipped",
			path: ["steps"],
		}
	);
export type ProofRecord = z.infer<typeof proofRecordSchema>;

// Passed only when every step that was meant to run passed.
export function deriveResult(steps: readonly ProofStep[]): "passed" | "failed" {
	for (const step of steps) {
		if (step.status !== "passed" && step.status !== "skipped")
			return "failed";
	}
	return "passed";
}

export function parseProofRecord(text: string): ProofRecord {
	if (Buffer.byteLength(text) > PROOF_NOTE_BYTES_MAX)
		throw new CommandError(
			`The proof note exceeds ${PROOF_NOTE_BYTES_MAX} bytes.`
		);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error: unknown) {
		throw new CommandError(`The proof note is not JSON: ${String(error)}`);
	}
	const parsed = proofRecordSchema.safeParse(json);
	if (!parsed.success)
		throw new CommandError(
			`The proof note is not a valid record:\n${z.prettifyError(parsed.error)}`
		);
	return parsed.data;
}

export function parseProofReview(text: string, nowIso: string): ProofReview {
	if (Buffer.byteLength(text) > PROOF_REVIEW_FILE_BYTES_MAX)
		throw new CommandError(
			`The review file exceeds ${PROOF_REVIEW_FILE_BYTES_MAX} bytes.`
		);
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error: unknown) {
		throw new CommandError(`The review file is not JSON: ${String(error)}`);
	}
	const parsed = proofReviewInputSchema.safeParse(json);
	if (!parsed.success)
		throw new CommandError(
			`The review is not valid:\n${z.prettifyError(parsed.error)}`
		);
	return proofReviewSchema.parse({
		...parsed.data,
		at: parsed.data.at ?? nowIso,
	});
}

export function addReview(
	record: ProofRecord,
	review: ProofReview
): ProofRecord {
	if (record.reviews.length >= PROOF_REVIEWS_MAX)
		throw new CommandError(
			`The proof already has the maximum of ${PROOF_REVIEWS_MAX} reviews.`
		);
	return { ...record, reviews: [...record.reviews, review] };
}

export type ProofCheckOptions = {
	readonly allowSkippedE2e: boolean;
	readonly requireReviewsCount: number;
};

export const PROOF_CHECK_DEFAULTS: ProofCheckOptions = {
	allowSkippedE2e: false,
	requireReviewsCount: 0,
};

export type ProofTarget = { readonly commit: string; readonly tree: string };

// Every reason the record does not prove the target; empty means it does.
export function evaluateProof(
	record: ProofRecord,
	target: ProofTarget,
	options: ProofCheckOptions
): readonly string[] {
	const reasons: string[] = [];
	if (record.commit !== target.commit)
		reasons.push(
			`The proof is for commit ${record.commit}, not ${target.commit}.`
		);
	if (record.tree !== target.tree)
		reasons.push(
			`The proof is for tree ${record.tree}, but the commit has tree ${target.tree}.`
		);
	if (record.result !== "passed") {
		const failed = record.steps.filter(
			(step) => step.status === "failed" || step.status === "timed_out"
		);
		reasons.push(
			`The proof failed (${failed.map((step) => `${step.name} ${step.status}`).join(", ")}).`
		);
	}
	if (record.steps[2].status === "skipped" && !options.allowSkippedE2e)
		reasons.push(
			"The proof skipped e2e; rerun without --skip-e2e or pass --allow-skipped-e2e."
		);
	const approvals = record.reviews.filter(
		(review) => review.verdict === "approve"
	).length;
	if (approvals < options.requireReviewsCount)
		reasons.push(
			`The proof has ${approvals} approving review(s); ${options.requireReviewsCount} required.`
		);
	return reasons;
}

function formatSeconds(durationMs: number): string {
	return `${(durationMs / 1_000).toFixed(1)} s`;
}

export function proofSummary(record: ProofRecord): string {
	const lines = [
		`Proof ${record.result.toUpperCase()}: commit ${record.commit.slice(0, 12)} (tree ${record.tree.slice(0, 12)}) in ${formatSeconds(record.durationMs)}`,
	];
	for (const step of record.steps) {
		const timing =
			step.status === "skipped" || step.status === "not_run"
				? ""
				: `  ${formatSeconds(step.durationMs)}`;
		lines.push(
			`  ${step.name.padEnd(8)}${step.status.padEnd(10)}${timing}`
		);
	}
	const approvals = record.reviews.filter(
		(review) => review.verdict === "approve"
	).length;
	lines.push(`  reviews ${record.reviews.length} (${approvals} approving)`);
	return lines.join("\n");
}

// --- git boundary ---------------------------------------------------------

function git(cwd: string, args: readonly string[], input?: string): string {
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		input,
		stdio: ["pipe", "pipe", "pipe"],
		timeout: PROOF_GIT_TIMEOUT_MS,
		maxBuffer: PROOF_NOTE_BYTES_MAX * 2,
	}).trim();
}

export function resolveTarget(rev: string, cwd = process.cwd()): ProofTarget {
	let commit: string;
	try {
		commit = git(cwd, [
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${rev}^{commit}`,
		]);
	} catch (error: unknown) {
		throw new CommandError(`"${rev}" is not a commit in this repository.`, {
			cause: error,
		});
	}
	const tree = git(cwd, ["rev-parse", "--verify", `${commit}^{tree}`]);
	return { commit, tree };
}

export type ProofRead =
	| { readonly kind: "missing"; readonly target: ProofTarget }
	| {
			readonly kind: "invalid";
			readonly target: ProofTarget;
			readonly error: string;
	  }
	| {
			readonly kind: "found";
			readonly target: ProofTarget;
			readonly record: ProofRecord;
	  };

function readNote(commit: string, cwd: string): string | null {
	try {
		return git(cwd, ["notes", `--ref=${PROOF_NOTES_REF}`, "show", commit]);
	} catch (error: unknown) {
		const stderr =
			error instanceof Error && "stderr" in error
				? String(error.stderr)
				: "";
		if (/no note found/i.test(stderr)) return null;
		throw error;
	}
}

export function readProof(rev: string, cwd = process.cwd()): ProofRead {
	const target = resolveTarget(rev, cwd);
	const text = readNote(target.commit, cwd);
	if (text === null) return { kind: "missing", target };
	try {
		return { kind: "found", target, record: parseProofRecord(text) };
	} catch (error: unknown) {
		// A malformed note is a check failure to report, not a crash.
		return {
			kind: "invalid",
			target,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export type ProofCheck = {
	readonly ok: boolean;
	readonly target: ProofTarget;
	readonly reasons: readonly string[];
	readonly record: ProofRecord | null;
};

export function checkProof(
	rev: string,
	options: ProofCheckOptions = PROOF_CHECK_DEFAULTS,
	cwd = process.cwd()
): ProofCheck {
	const read = readProof(rev, cwd);
	switch (read.kind) {
		case "missing":
			return {
				ok: false,
				target: read.target,
				reasons: [
					`No proof for ${read.target.commit}; run \`pnpm proof\` (or fetch ${PROOF_NOTES_REF}).`,
				],
				record: null,
			};
		case "invalid":
			return {
				ok: false,
				target: read.target,
				reasons: [read.error],
				record: null,
			};
		case "found": {
			const reasons = evaluateProof(read.record, read.target, options);
			return {
				ok: reasons.length === 0,
				target: read.target,
				reasons,
				record: read.record,
			};
		}
	}
}

// Replaces any earlier note on the commit: the newest proof wins.
export function writeProof(record: ProofRecord, cwd = process.cwd()): void {
	const text = `${JSON.stringify(proofRecordSchema.parse(record), null, "\t")}\n`;
	if (Buffer.byteLength(text) > PROOF_NOTE_BYTES_MAX)
		throw new CommandError(
			`The proof record exceeds ${PROOF_NOTE_BYTES_MAX} bytes.`
		);
	try {
		git(
			cwd,
			[
				"notes",
				`--ref=${PROOF_NOTES_REF}`,
				"add",
				"--force",
				"--file=-",
				record.commit,
			],
			text
		);
	} catch (error: unknown) {
		const stderr =
			error instanceof Error && "stderr" in error
				? String(error.stderr).trim()
				: "";
		throw new CommandError(
			`git notes failed (${errorCode(error) ?? "exit"}): ${stderr}`,
			{ cause: error }
		);
	}
}
