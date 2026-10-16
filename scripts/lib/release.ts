// Pure decisions and boundary parsers for `pnpm ci:wait` and `pnpm ship`,
// kept apart from gh, git, and the network so tooling tests drive them
// directly.

import { z } from "zod";
import { CommandError, UsageError } from "./cli.ts";

// gh's check-runs endpoint returns at most this many runs per page; ci:wait
// reads one page and refuses to judge a commit with more.
export const CHECK_RUNS_PER_PAGE_MAX = 100;

// Cloudflare can route some requests to the previous version while a deploy
// propagates, so the new commit must be served several times in a row.
export const LIVE_CONFIRMATIONS_COUNT = 3;

// Enough of a failing job's log to show the error without flooding output.
export const FAILURE_EXCERPT_LINES_MAX = 40;

export class ReleaseError extends CommandError {}

const checkRunSchema = z.object({
	id: z.number().optional(),
	name: z.string(),
	status: z.string(),
	conclusion: z.string().nullable(),
	html_url: z.string().nullable().optional(),
	details_url: z.string().nullable().optional(),
	app: z.object({ slug: z.string().optional() }).nullable().optional(),
});
export type CheckRun = z.infer<typeof checkRunSchema>;

const checkRunsResponseSchema = z.object({
	total_count: z.number().int().min(0),
	check_runs: z.array(checkRunSchema),
});

export type CheckResult = "pass" | "skip" | "fail" | "pending";

export type Check = {
	readonly name: string;
	readonly result: CheckResult;
	readonly conclusion: string;
	readonly jobId: string | null;
	readonly url: string | null;
};

export type CheckSummary = {
	readonly state: "pending" | "passed" | "failed";
	readonly checks: readonly Check[];
	readonly failed: readonly Check[];
};

// `gh api .../check-runs` output -> the runs on the commit. More runs than
// one page holds would leave some unread, so that is an error, not a pass.
export function parseCheckRuns(json: string): readonly CheckRun[] {
	const response = checkRunsResponseSchema.parse(JSON.parse(json));
	if (response.total_count > response.check_runs.length)
		throw new ReleaseError(
			`The commit has ${response.total_count} check runs; ci:wait reads at most ${CHECK_RUNS_PER_PAGE_MAX}.`
		);
	return response.check_runs;
}

function checkResult(run: CheckRun): CheckResult {
	if (run.status !== "completed") return "pending";
	if (run.conclusion === "success") return "pass";
	if (run.conclusion === "skipped" || run.conclusion === "neutral")
		return "skip";
	return "fail";
}

function summaryState(checks: readonly Check[]): CheckSummary["state"] {
	if (checks.length === 0) return "pending";
	if (checks.some((check) => check.result === "pending")) return "pending";
	if (checks.some((check) => check.result === "fail")) return "failed";
	return "passed";
}

// GitHub check runs -> one verdict. No runs yet, or any unfinished run, is
// "pending": a ref is never reported green before CI has reported. A commit
// can carry several runs per check (push, schedule, re-run); the newest wins.
export function summarizeChecks(runs: readonly CheckRun[]): CheckSummary {
	const latest = new Map<string, CheckRun>();
	for (const run of runs) {
		const previous = latest.get(run.name);
		if (previous === undefined || (previous.id ?? 0) < (run.id ?? 0))
			latest.set(run.name, run);
	}
	const checks = [...latest.values()]
		.map((run) => ({
			name: run.name,
			result: checkResult(run),
			conclusion: run.conclusion ?? run.status,
			jobId: actionsJobId(run),
			url: run.html_url ?? run.details_url ?? null,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const failed = checks.filter((check) => check.result === "fail");
	return { state: summaryState(checks), checks, failed };
}

export function formatChecks(checks: readonly Check[]): string {
	if (checks.length === 0) return "  (no check runs reported yet)";
	return checks
		.map((check) => {
			const detail =
				check.result === "fail" ? ` (${check.conclusion})` : "";
			return `  ${check.result.padEnd(7)} ${check.name}${detail}`;
		})
		.join("\n");
}

// GitHub Actions check runs link to their job; `gh run view --job` reads its log.
export function actionsJobId(run: CheckRun): string | null {
	const slug = run.app?.slug;
	if (slug !== undefined && slug !== "github-actions") return null;
	const match = /\/job\/(\d+)/.exec(run.html_url ?? run.details_url ?? "");
	return match?.[1] ?? null;
}

// `gh run view --log-failed` prints "job<TAB>step<TAB>timestamp line" and ends
// with cleanup noise; keep the lines leading up to the last error.
export function failureExcerpt(
	log: string,
	lineCountMax = FAILURE_EXCERPT_LINES_MAX
): string {
	const text = log
		.trimEnd()
		.split("\n")
		.map((line) =>
			line.replace(/^[^\t]*\t[^\t]*\t\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
		);
	const lastErrorIndex = text.findLastIndex((line) =>
		line.includes("##[error]")
	);
	const endIndex = lastErrorIndex === -1 ? text.length : lastErrorIndex + 1;
	return text
		.slice(Math.max(0, endIndex - lineCountMax), endIndex)
		.join("\n");
}

export type Target =
	| { readonly kind: "ref"; readonly ref: string }
	| { readonly kind: "pr"; readonly number: number };

// "12" or "#12" -> a pull request number; anything else -> null.
export function parsePullRequestNumber(value: string): number | null {
	const match = /^#?(\d+)$/.exec(value);
	if (match?.[1] === undefined) return null;
	const number = Number(match[1]);
	if (!Number.isSafeInteger(number) || number < 1)
		throw new UsageError(
			`A pull request number must be a positive integer, got "${value}".`
		);
	return number;
}

// `pnpm ci:wait 12` / `#12` waits on a PR head; anything else is a git ref.
export function parseTarget(value: string | undefined): Target {
	if (value === undefined) return { kind: "ref", ref: "HEAD" };
	const number = parsePullRequestNumber(value);
	if (number === null) return { kind: "ref", ref: value };
	return { kind: "pr", number };
}

const pullRequestSchema = z.object({
	number: z.number().int(),
	title: z.string(),
	url: z.string(),
	state: z.enum(["OPEN", "CLOSED", "MERGED"]),
	isDraft: z.boolean(),
	baseRefName: z.string(),
	headRefOid: z.string(),
	mergeCommit: z.object({ oid: z.string() }).nullable(),
});
export type PullRequest = z.infer<typeof pullRequestSchema>;
export const PULL_REQUEST_FIELDS = Object.keys(pullRequestSchema.shape).join(
	","
);

export function parsePullRequest(json: string): PullRequest {
	return pullRequestSchema.parse(JSON.parse(json));
}

// What `pnpm ship` does with a PR from `gh pr view`. A merged PR resumes at
// the deploy, so rerunning after a failure never merges twice.
export function mergeAction(
	pr: Pick<PullRequest, "number" | "state" | "isDraft">
): "merge" | "resume" {
	switch (pr.state) {
		case "MERGED":
			return "resume";
		case "CLOSED":
			throw new ReleaseError(
				`PR #${pr.number} is closed without merging.`
			);
		case "OPEN":
			if (pr.isDraft)
				throw new ReleaseError(`PR #${pr.number} is a draft.`);
			return "merge";
		default:
			return assertNever(pr.state);
	}
}

export function productionOrigin(appUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(appUrl);
	} catch (error: unknown) {
		throw new ReleaseError(
			`deploymentCloudflare.vars.APP_URL in config/cloudflare.mjs is not a URL: ${appUrl}`,
			{ cause: error }
		);
	}
	if (parsed.hostname.endsWith(".example") || parsed.protocol !== "https:")
		throw new ReleaseError(
			`Set deploymentCloudflare.vars.APP_URL in config/cloudflare.mjs to your production HTTPS origin (now ${appUrl}).`
		);
	return parsed.origin;
}

const healthSchema = z.object({
	commit: z.string().nullable(),
	version: z.string().nullable().optional(),
});

export type HealthRead =
	| {
			readonly kind: "served";
			readonly commit: string | null;
			readonly version: string | null;
	  }
	| { readonly kind: "unavailable"; readonly reason: string };

// A /api/health body -> what production serves. A body that is not the
// health JSON (an error page, an older build) counts as unavailable.
export function parseHealth(body: string): HealthRead {
	let json: unknown;
	try {
		json = JSON.parse(body);
	} catch {
		// An HTML error page during a rollout; the caller keeps polling.
		return { kind: "unavailable", reason: "response is not JSON" };
	}
	const parsed = healthSchema.safeParse(json);
	if (!parsed.success)
		return { kind: "unavailable", reason: "response has no commit field" };
	return {
		kind: "served",
		commit: parsed.data.commit,
		version: parsed.data.version ?? null,
	};
}

export function servedCommit(health: HealthRead): string | null {
	if (health.kind === "served") return health.commit;
	return null;
}

export function releaseSummary(summary: {
	readonly origin: string;
	readonly adminEmail: string;
}): string {
	const { origin, adminEmail } = summary;
	return [
		`Production: ${origin}`,
		`Sign in:    ${origin}/app/login`,
		`Admin:      ${adminEmail} (ADMIN_EMAIL in config/cloudflare.mjs).`,
		"            First deploy: POST /api/internal/bootstrap-admin with header",
		"            x-bootstrap-secret: <BOOTSTRAP_SECRET> (set with `void secret put`);",
		"            it emails ADMIN_EMAIL a link to set the password. No password is stored.",
	].join("\n");
}

export function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}
