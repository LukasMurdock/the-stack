// `pnpm ship` releases to production; running it is the operator's approval.
// Trunk mode (no argument) lands the proved HEAD on main with its proof note
// in one atomic push (scripts/lib/trunk.ts). `pnpm ship <pr>` instead waits
// for a pull request's CI, merges it and fast-forwards its base branch. Both
// then run `scripts/deploy.mjs` and wait until production's /api/health
// serves the commit. Rerunning resumes: a landed commit or merged PR is not
// pushed or merged again, and a commit production already serves skips the
// deploy.

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
	parseBoundedInteger,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	assertNever,
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
import {
	DEPLOY_STATE_PATHS,
	describeLanding,
	formatPreconditions,
	type Landing,
	landOnMain,
	readTrunkState,
	type TrunkState,
} from "./lib/trunk.ts";
import {
	formatChanges,
	PROOF_NOTES_REF,
	PROOF_REVIEWS_MAX,
	WORKING_TREE_STATUS_ARGS,
	workingTreeChanges,
} from "./lib/proof.ts";

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

export const SHIP_USAGE = `Usage: pnpm ship [--dry-run] [--require-reviews <n>]
       pnpm ship <pr> [--merge | --squash | --rebase] [--timeout <minutes>]

Trunk (default, no <pr>): lands the committed HEAD on main and deploys it.
Requires a clean tree, a passing \`pnpm proof\` of HEAD, and that origin's
main fast-forwards to HEAD. Pushes HEAD to main and ${PROOF_NOTES_REF} in one
atomic push (merging notes others pushed), runs scripts/deploy.mjs, and waits
until production serves HEAD. Needs only git and an origin remote.

  --dry-run                      Print each precondition and the steps it
                                 would take; change nothing.
  --require-reviews <n>          Also require n approving proof reviews
                                 (max ${PROOF_REVIEWS_MAX}).

Pull request (<pr>, for PR-based teams and outside contributions): waits for
the PR's CI through gh, merges it, fast-forwards its base branch, deploys,
and waits until production serves the merged commit.

  --merge | --squash | --rebase  Merge method (default --merge).
  --timeout <minutes>            CI wait in whole minutes
                                 (default ${CI_WAIT_TIMEOUT_MINUTES_DEFAULT}, max ${CI_WAIT_TIMEOUT_MINUTES_MAX}).

Rerun after a failure: nothing is pushed, merged or deployed twice.

  -h, --help                     Show this help.`;

export type PullRequestShipOptions = {
	readonly mode: "pr";
	readonly pullRequestNumber: number;
	readonly mergeMethod: MergeMethod;
	readonly ciTimeoutMs: number;
	readonly liveTimeoutMs: number;
};

export type TrunkShipOptions = {
	readonly mode: "trunk";
	readonly requireReviewsCount: number;
	readonly dryRun: boolean;
	readonly liveTimeoutMs: number;
};

export type ShipOptions = PullRequestShipOptions | TrunkShipOptions;

export type ShipConfig = {
	readonly vars: { readonly APP_URL: string; readonly ADMIN_EMAIL: string };
};

const SHIP_ARGS = {
	merge: { type: "boolean" },
	squash: { type: "boolean" },
	rebase: { type: "boolean" },
	timeout: { type: "string" },
	"dry-run": { type: "boolean" },
	"require-reviews": { type: "string" },
	help: { type: "boolean", short: "h" },
} as const;
type ShipArgs = ReturnType<typeof parseCommandLine<typeof SHIP_ARGS>>["values"];

const PULL_REQUEST_FLAGS = ["merge", "squash", "rebase", "timeout"] as const;
const TRUNK_FLAGS = ["dry-run", "require-reviews"] as const;

// No positional argument selects trunk mode; a PR number selects PR mode.
// Flags of the other mode are usage errors, not ignored.
export function parseShipOptions(
	argv: readonly string[]
): Command<ShipOptions> {
	const { values, positionals } = parseCommandLine(argv, SHIP_ARGS);
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 1)
		throw new UsageError(
			`Expected at most one <pr>, got: ${positionals.join(" ")}.`
		);
	const argument = positionals[0];
	if (argument === undefined)
		return { kind: "run", options: parseTrunkOptions(values) };
	return { kind: "run", options: parsePullRequestOptions(argument, values) };
}

function parseTrunkOptions(values: ShipArgs): TrunkShipOptions {
	const flag = PULL_REQUEST_FLAGS.find((name) => values[name] !== undefined);
	if (flag !== undefined)
		throw new UsageError(`--${flag} only applies with a <pr>.`);
	const requireReviews = values["require-reviews"];
	let requireReviewsCount = 0;
	if (requireReviews !== undefined)
		requireReviewsCount = parseBoundedInteger(requireReviews, {
			name: "--require-reviews",
			min: 0,
			max: PROOF_REVIEWS_MAX,
		});
	return {
		mode: "trunk",
		requireReviewsCount,
		dryRun: values["dry-run"] === true,
		liveTimeoutMs: LIVE_WAIT_TIMEOUT_MS_DEFAULT,
	};
}

function parsePullRequestOptions(
	argument: string,
	values: ShipArgs
): PullRequestShipOptions {
	const flag = TRUNK_FLAGS.find((name) => values[name] !== undefined);
	if (flag !== undefined)
		throw new UsageError(
			`--${flag} only applies to trunk mode (pnpm ship without a <pr>).`
		);
	const methods = MERGE_METHODS.filter((method) => values[method] === true);
	if (methods.length > 1)
		throw new UsageError(
			`Choose one merge method, got ${methods.map((method) => `--${method}`).join(" ")}.`
		);
	const pullRequestNumber = parsePullRequestNumber(argument);
	if (pullRequestNumber === null)
		throw new UsageError(
			`<pr> must be a pull request number, got "${argument}".`
		);
	return {
		mode: "pr",
		pullRequestNumber,
		mergeMethod: methods[0] ?? "merge",
		ciTimeoutMs: parseCiTimeoutMs(values.timeout),
		liveTimeoutMs: LIVE_WAIT_TIMEOUT_MS_DEFAULT,
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
	const status = capture(io, "git", [...WORKING_TREE_STATUS_ARGS]);
	const changes = workingTreeChanges(status, DEPLOY_STATE_PATHS);
	if (changes.length > 0)
		throw new ReleaseError(
			`Commit or stash local changes before shipping:\n${formatChanges(changes)}`
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
	options: PullRequestShipOptions
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
	switch (options.mode) {
		case "trunk":
			return shipTrunk(io, options, config);
		case "pr":
			return shipPullRequest(io, options, config);
		default:
			return assertNever(options);
	}
}

async function shipPullRequest(
	io: ReleaseIo,
	options: PullRequestShipOptions,
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
	await confirmRelease(io, {
		release: { origin, commit, label: `PR #${pr.number}` },
		liveTimeoutMs: options.liveTimeoutMs,
		config,
	});
}

async function shipTrunk(
	io: ReleaseIo,
	options: TrunkShipOptions,
	config: ShipConfig
): Promise<void> {
	const state = readTrunkState(io, {
		appUrl: config.vars.APP_URL,
		proof: {
			allowSkippedE2e: false,
			requireReviewsCount: options.requireReviewsCount,
		},
	});
	if (options.dryRun) return printTrunkPlan(io, state);
	const landing = readyLanding(io, state);
	io.log(`\n==> Landing ${landing.commit.slice(0, 12)} on main`);
	if (landOnMain(io, landing) === "already-landed")
		io.log(
			"origin main is HEAD and has its proof note; skipping the push."
		);
	await deployUnlessLive(io, landing.origin, landing.commit);
	await confirmRelease(io, {
		release: {
			origin: landing.origin,
			commit: landing.commit,
			label: "main",
		},
		liveTimeoutMs: options.liveTimeoutMs,
		config,
	});
}

function readyLanding(io: ReleaseIo, state: TrunkState): Landing {
	io.log(`Shipping HEAD ${state.commit} to main.`);
	io.log(formatPreconditions(state.preconditions));
	if (state.landing === null)
		throw new ReleaseError(
			"Nothing was pushed or deployed. Fix the FAIL lines above, then rerun pnpm ship."
		);
	return state.landing;
}

async function printTrunkPlan(io: ReleaseIo, state: TrunkState): Promise<void> {
	io.log(`Dry run for ${state.commit}; nothing changes.\n\nPreconditions:`);
	io.log(formatPreconditions(state.preconditions));
	const landing = state.landing;
	if (landing === null)
		throw new ReleaseError(
			"A ship would stop here: fix the FAIL lines above, then rerun pnpm ship."
		);
	const short = landing.commit.slice(0, 12);
	const steps = describeLanding(io, landing);
	if (servedCommit(await readHealth(io, landing.origin)) === landing.commit) {
		steps.push(`skip the deploy: production already serves ${short}`);
	} else {
		steps.push(
			"pnpm install --frozen-lockfile",
			`node scripts/deploy.mjs (STACK_COMMIT=${landing.commit})`
		);
	}
	steps.push(
		`wait until ${landing.origin}/api/health serves ${short} ${LIVE_CONFIRMATIONS_COUNT} times in a row, then check /api/readiness`
	);
	io.log("\nSteps:");
	io.log(steps.map((step, index) => `  ${index + 1}. ${step}`).join("\n"));
}

type ConfirmRelease = {
	readonly release: {
		readonly origin: string;
		readonly commit: string;
		readonly label: string;
	};
	readonly liveTimeoutMs: number;
	readonly config: ShipConfig;
};

async function confirmRelease(
	io: ReleaseIo,
	{ release, liveTimeoutMs, config }: ConfirmRelease
): Promise<void> {
	const { origin, commit } = release;
	io.log(`\n==> Waiting for ${origin} to serve ${commit.slice(0, 12)}`);
	const health = await waitUntilLive(io, { origin, commit }, liveTimeoutMs);
	const version = health.kind === "served" ? health.version : null;
	io.log(
		`\nShipped ${release.label} at ${commit.slice(0, 12)} (Worker version ${version ?? "unknown"}).`
	);
	io.log(releaseSummary({ origin, adminEmail: config.vars.ADMIN_EMAIL }));
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: SHIP_USAGE,
		parse: () => parseShipOptions(process.argv.slice(2)),
		run: (options) => ship(defaultIo, options, deploymentCloudflare),
	});
