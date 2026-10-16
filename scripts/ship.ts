// `pnpm ship <pr>` releases one pull request: wait for its CI, merge it,
// fast-forward the base branch, run `scripts/deploy.mjs`, then wait until
// production's /api/health serves the deployed commit. Running it is the
// operator's production approval. Rerunning resumes: a merged PR skips the
// merge, and a commit production already serves skips the deploy.

import { deploymentCloudflare } from "../config/cloudflare.mjs";
import {
	capture,
	CI_POLL_INTERVAL_MS,
	CI_WAIT_TIMEOUT_MINUTES_DEFAULT,
	CI_WAIT_TIMEOUT_MINUTES_MAX,
	COMMAND_TIMEOUT_MS,
	defaultIo,
	type ExecOptions,
	parseCiTimeoutMs,
	type ReleaseIo,
	waitForChecks,
} from "./ci-wait.ts";
import {
	type Command,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	type HealthRead,
	LIVE_CONFIRMATIONS_COUNT,
	mergeAction,
	parseHealth,
	parsePullRequest,
	parsePullRequestNumber,
	productionOrigin,
	PULL_REQUEST_FIELDS,
	type PullRequest,
	ReleaseError,
	releaseSummary,
	servedCommit,
} from "./lib/release.ts";

export const LIVE_WAIT_TIMEOUT_MS_DEFAULT = 5 * 60_000;
// Between polls while production still serves the previous commit.
export const LIVE_POLL_INTERVAL_MS = 5_000;
// Between the consecutive confirmations of the new commit.
export const LIVE_CONFIRM_INTERVAL_MS = 1_000;
// One health request; the live deadline bounds the whole wait.
export const HEALTH_REQUEST_TIMEOUT_MS = 10_000;

// Node's fetch ignores RequestInit.cache; ask any cache on the way to revalidate.
const NO_CACHE_HEADERS = { "cache-control": "no-cache" };

const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const SHIP_USAGE = `Usage: pnpm ship <pr> [--merge | --squash | --rebase] [--timeout <minutes>]

Waits for the pull request's CI, merges it, fast-forwards its base branch,
deploys, and waits until production serves the merged commit.

  --merge | --squash | --rebase  Merge method (default --merge).
  --timeout <minutes>            CI wait in whole minutes
                                 (default ${CI_WAIT_TIMEOUT_MINUTES_DEFAULT}, max ${CI_WAIT_TIMEOUT_MINUTES_MAX}).
  -h, --help                     Show this help.`;

export type ShipOptions = {
	readonly pullRequestNumber: number;
	readonly mergeMethod: MergeMethod;
	readonly ciTimeoutMs: number;
	readonly liveTimeoutMs: number;
};

export type ShipConfig = {
	readonly vars: { readonly APP_URL: string; readonly ADMIN_EMAIL: string };
};

export function parseShipOptions(
	argv: readonly string[]
): Command<ShipOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		merge: { type: "boolean" },
		squash: { type: "boolean" },
		rebase: { type: "boolean" },
		timeout: { type: "string" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	const methods = MERGE_METHODS.filter((method) => values[method] === true);
	if (methods.length > 1)
		throw new UsageError(
			`Choose one merge method, got ${methods.map((method) => `--${method}`).join(" ")}.`
		);
	const [argument, ...extra] = positionals;
	if (argument === undefined) throw new UsageError("Missing <pr>.");
	if (extra.length > 0)
		throw new UsageError(
			`Expected one <pr>, got: ${positionals.join(" ")}.`
		);
	const pullRequestNumber = parsePullRequestNumber(argument);
	if (pullRequestNumber === null)
		throw new UsageError(
			`<pr> must be a pull request number, got "${argument}".`
		);
	return {
		kind: "run",
		options: {
			pullRequestNumber,
			mergeMethod: methods[0] ?? "merge",
			ciTimeoutMs: parseCiTimeoutMs(values.timeout),
			liveTimeoutMs: LIVE_WAIT_TIMEOUT_MS_DEFAULT,
		},
	};
}

function describeFetchError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	if (error.name === "TimeoutError")
		return `no response within ${HEALTH_REQUEST_TIMEOUT_MS / 1_000} s`;
	const cause: unknown = error.cause;
	if (cause instanceof Error) return `${error.message}: ${cause.message}`;
	return error.message;
}

async function readHealth(io: ReleaseIo, origin: string): Promise<HealthRead> {
	try {
		const response = await io.fetch(`${origin}/api/health`, {
			headers: NO_CACHE_HEADERS,
			signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
		});
		if (!response.ok)
			return { kind: "unavailable", reason: `HTTP ${response.status}` };
		return parseHealth(await response.text());
	} catch (error: unknown) {
		// Expected while a deploy propagates: keep polling, and report the
		// last reason if the live deadline passes.
		return { kind: "unavailable", reason: describeFetchError(error) };
	}
}

function describeHealth(health: HealthRead): string {
	if (health.kind === "unavailable") return `no commit (${health.reason})`;
	return health.commit ?? "no commit";
}

async function checkReadiness(io: ReleaseIo, origin: string): Promise<void> {
	let response: Response;
	try {
		response = await io.fetch(`${origin}/api/readiness`, {
			headers: NO_CACHE_HEADERS,
			signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
		});
	} catch (error: unknown) {
		throw new ReleaseError(
			`/api/readiness failed: ${describeFetchError(error)}.`,
			{ cause: error }
		);
	}
	if (!response.ok)
		throw new ReleaseError(`/api/readiness returned ${response.status}.`);
}

async function waitUntilLive(
	io: ReleaseIo,
	target: { readonly origin: string; readonly commit: string },
	liveTimeoutMs: number
): Promise<HealthRead> {
	const deadlineMs = io.nowMs() + liveTimeoutMs;
	let confirmationsCount = 0;
	for (;;) {
		const health = await readHealth(io, target.origin);
		if (servedCommit(health) === target.commit) {
			confirmationsCount += 1;
		} else {
			confirmationsCount = 0;
		}
		if (confirmationsCount >= LIVE_CONFIRMATIONS_COUNT) {
			await checkReadiness(io, target.origin);
			return health;
		}
		if (io.nowMs() >= deadlineMs)
			throw new ReleaseError(
				`Production serves ${describeHealth(health)}; expected ${target.commit}.`
			);
		if (confirmationsCount > 0) {
			await io.sleep(LIVE_CONFIRM_INTERVAL_MS);
		} else {
			await io.sleep(LIVE_POLL_INTERVAL_MS);
		}
	}
}

function run(
	io: ReleaseIo,
	command: string,
	args: readonly string[],
	options: Omit<ExecOptions, "stdio">
): void {
	const result = io.exec(command, args, { ...options, stdio: "inherit" });
	if (result.status !== 0)
		throw new ReleaseError(
			`${command} ${args.join(" ")} exited with ${result.status}.`
		);
}

function assertCleanCheckout(io: ReleaseIo): void {
	// A failed deploy can leave newly recorded resource IDs; keep them so
	// the rerun reuses those resources (commit void.lock.json afterwards).
	const changes = capture(io, "git", ["status", "--porcelain"])
		.split("\n")
		.filter((line) => line !== "" && !line.endsWith(" void.lock.json"));
	if (changes.length > 0)
		throw new ReleaseError(
			`Commit or stash local changes before shipping:\n${changes.join("\n")}`
		);
}

function viewPullRequest(io: ReleaseIo, number: number): PullRequest {
	const json = capture(io, "gh", [
		"pr",
		"view",
		String(number),
		"--json",
		PULL_REQUEST_FIELDS,
	]);
	return parsePullRequest(json);
}

async function mergeWhenGreen(
	io: ReleaseIo,
	pr: PullRequest,
	options: ShipOptions
): Promise<PullRequest> {
	io.log("\n==> Waiting for CI");
	await waitForChecks(io, pr.headRefOid, {
		ciTimeoutMs: options.ciTimeoutMs,
		pollIntervalMs: CI_POLL_INTERVAL_MS,
	});
	io.log("\n==> Merging");
	// Refuses to merge if the head moved after the checks passed.
	run(
		io,
		"gh",
		[
			"pr",
			"merge",
			String(pr.number),
			`--${options.mergeMethod}`,
			"--match-head-commit",
			pr.headRefOid,
		],
		{ timeoutMs: COMMAND_TIMEOUT_MS }
	);
	const merged = viewPullRequest(io, pr.number);
	if (merged.state !== "MERGED")
		throw new ReleaseError(
			`PR #${pr.number} is ${merged.state} after merging (auto-merge or a merge queue?). Rerun once it merges.`
		);
	return merged;
}

// Returns the commit to deploy: the base branch head, which contains the PR.
function fastForward(io: ReleaseIo, pr: PullRequest): string {
	const base = pr.baseRefName;
	const mergeSha = pr.mergeCommit?.oid;
	if (mergeSha === undefined)
		throw new ReleaseError(`PR #${pr.number} has no merge commit.`);
	io.log(`\n==> Fast-forwarding ${base}`);
	const bounded = { timeoutMs: COMMAND_TIMEOUT_MS };
	run(io, "git", ["fetch", "origin", base], bounded);
	run(io, "git", ["checkout", base], bounded);
	run(io, "git", ["merge", "--ff-only", `origin/${base}`], bounded);
	// Later merges ship too, but never a checkout without this PR.
	const ancestry = io.exec(
		"git",
		["merge-base", "--is-ancestor", mergeSha, "HEAD"],
		{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
	);
	if (ancestry.status !== 0)
		throw new ReleaseError(`${base} does not contain ${mergeSha}.`);
	return capture(io, "git", ["rev-parse", "HEAD"]);
}

async function deployUnlessLive(
	io: ReleaseIo,
	origin: string,
	commit: string
): Promise<void> {
	if (servedCommit(await readHealth(io, origin)) === commit) {
		io.log(
			`Production already serves ${commit.slice(0, 12)}; skipping the deploy.`
		);
		return;
	}
	// Unbounded on purpose: killing an install or deploy midway leaves
	// partial state, and the operator watches its output.
	run(io, "pnpm", ["install", "--frozen-lockfile"], { timeoutMs: null });
	io.log("\n==> Deploying (scripts/deploy.mjs)");
	run(io, "node", ["scripts/deploy.mjs"], {
		timeoutMs: null,
		env: { STACK_COMMIT: commit, STACK_SHIP: "1" },
	});
}

export async function ship(
	io: ReleaseIo,
	options: ShipOptions,
	config: ShipConfig
): Promise<void> {
	const origin = productionOrigin(config.vars.APP_URL);
	assertCleanCheckout(io);
	let pr = viewPullRequest(io, options.pullRequestNumber);
	io.log(`PR #${pr.number}: ${pr.title}\n${pr.url}`);
	if (mergeAction(pr) === "merge") {
		pr = await mergeWhenGreen(io, pr, options);
	} else {
		io.log("Already merged; resuming at the deploy.");
	}
	const commit = fastForward(io, pr);
	await deployUnlessLive(io, origin, commit);
	io.log(`\n==> Waiting for ${origin} to serve ${commit.slice(0, 12)}`);
	const health = await waitUntilLive(
		io,
		{ origin, commit },
		options.liveTimeoutMs
	);
	const version = health.kind === "served" ? health.version : null;
	io.log(
		`\nShipped PR #${pr.number} at ${commit.slice(0, 12)} (Worker version ${version ?? "unknown"}).`
	);
	io.log(releaseSummary({ origin, adminEmail: config.vars.ADMIN_EMAIL }));
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: SHIP_USAGE,
		parse: () => parseShipOptions(process.argv.slice(2)),
		run: (options) => ship(defaultIo, options, deploymentCloudflare),
	});
