// `pnpm ci:wait [ref|pr]` waits for every GitHub check run on a commit
// (default: HEAD) through the gh CLI, so GH_HOST/GH_TOKEN/GH_REPO apply.
// Exits 1 on failure or timeout and prints failing jobs' log tails; exits 2
// on a malformed command line.

import { spawnSync } from "node:child_process";
import {
	type Command,
	CommandError,
	errorCode,
	isEntryPoint,
	parseBoundedInteger,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	type Check,
	type CheckSummary,
	CHECK_RUNS_PER_PAGE_MAX,
	failureExcerpt,
	formatChecks,
	parseCheckRuns,
	parseTarget,
	ReleaseError,
	summarizeChecks,
	type Target,
} from "./lib/release.ts";

export const CI_WAIT_TIMEOUT_MINUTES_DEFAULT = 30;
export const CI_WAIT_TIMEOUT_MS_DEFAULT =
	CI_WAIT_TIMEOUT_MINUTES_DEFAULT * 60_000;
// GitHub Actions stops a job after six hours; waiting longer only hides a
// stuck run.
export const CI_WAIT_TIMEOUT_MINUTES_MAX = 6 * 60;
export const CI_POLL_INTERVAL_MS = 10_000;
// gh and git answer in seconds. A hung proxy or credential prompt must fail
// the command instead of blocking past the CI deadline.
export const COMMAND_TIMEOUT_MS = 2 * 60_000;

export const CI_WAIT_USAGE = `Usage: pnpm ci:wait [ref | pr] [--timeout <minutes>]

Waits for every GitHub check run on a commit. The target is a git ref
(default HEAD, which must be pushed) or a pull request number (12 or #12).

  --timeout <minutes>  Give up after this many whole minutes
                       (default ${CI_WAIT_TIMEOUT_MINUTES_DEFAULT}, max ${CI_WAIT_TIMEOUT_MINUTES_MAX}).
  -h, --help           Show this help.`;

export type CiWaitOptions = {
	readonly target: Target;
	readonly ciTimeoutMs: number;
};

export type ExecResult = {
	readonly status: number;
	readonly stdout: string;
	readonly stderr: string;
};

export type ExecOptions = {
	readonly stdio: "capture" | "inherit";
	// null: deliberately unbounded (an interactive deploy the operator watches).
	readonly timeoutMs: number | null;
	readonly env?: Readonly<Record<string, string>>;
};

// The external boundary of ci:wait and ship: subprocesses, HTTP, the clock.
export type ReleaseIo = {
	exec(
		command: string,
		args: readonly string[],
		options: ExecOptions
	): ExecResult;
	fetch(url: string, init: RequestInit): Promise<Response>;
	sleep(durationMs: number): Promise<void>;
	nowMs(): number;
	log(line: string): void;
};

export const defaultIo: ReleaseIo = {
	exec(command, args, options) {
		const result = spawnSync(command, args, {
			encoding: "utf8",
			env:
				options.env === undefined
					? process.env
					: { ...process.env, ...options.env },
			stdio:
				options.stdio === "inherit"
					? "inherit"
					: ["ignore", "pipe", "pipe"],
			timeout: options.timeoutMs ?? undefined,
		});
		if (result.error !== undefined) {
			if (errorCode(result.error) === "ETIMEDOUT")
				throw new CommandError(
					`${command} ${args.join(" ")} did not finish within ${(options.timeoutMs ?? 0) / 1_000} s.`
				);
			throw result.error;
		}
		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	},
	fetch: (url, init) => fetch(url, init),
	sleep: (durationMs) =>
		new Promise((resolve) => setTimeout(resolve, durationMs)),
	nowMs: () => Date.now(),
	log(line) {
		process.stdout.write(`${line}\n`);
	},
};

export function parseCiTimeoutMs(minutes: string | undefined): number {
	if (minutes === undefined) return CI_WAIT_TIMEOUT_MS_DEFAULT;
	const parsed = parseBoundedInteger(minutes, {
		name: "--timeout (minutes)",
		min: 1,
		max: CI_WAIT_TIMEOUT_MINUTES_MAX,
	});
	return parsed * 60_000;
}

export function parseCiWaitOptions(
	argv: readonly string[]
): Command<CiWaitOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		timeout: { type: "string" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 1)
		throw new UsageError(
			`Expected at most one ref or pull request, got: ${positionals.join(" ")}.`
		);
	return {
		kind: "run",
		options: {
			target: parseTarget(positionals[0]),
			ciTimeoutMs: parseCiTimeoutMs(values.timeout),
		},
	};
}

export function capture(
	io: ReleaseIo,
	command: string,
	args: readonly string[]
): string {
	const result = io.exec(command, args, {
		stdio: "capture",
		timeoutMs: COMMAND_TIMEOUT_MS,
	});
	if (result.status !== 0)
		throw new ReleaseError(
			`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
		);
	return result.stdout.trim();
}

export function resolveSha(io: ReleaseIo, target: Target): string {
	switch (target.kind) {
		case "pr":
			return capture(io, "gh", [
				"pr",
				"view",
				String(target.number),
				"--json",
				"headRefOid",
				"--jq",
				".headRefOid",
			]);
		case "ref":
			return capture(io, "git", [
				"rev-parse",
				"--verify",
				`${target.ref}^{commit}`,
			]);
	}
}

function printFailureLogs(io: ReleaseIo, failed: readonly Check[]): void {
	for (const check of failed) {
		const url = check.url === null ? "" : ` ${check.url}`;
		io.log(`\n--- ${check.name}: ${check.conclusion}${url}`);
		if (check.jobId === null) continue;
		const log = io.exec(
			"gh",
			["run", "view", "--job", check.jobId, "--log-failed"],
			{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
		);
		if (log.status === 0 && log.stdout.trim() !== "") {
			io.log(failureExcerpt(log.stdout));
		} else {
			io.log("(log unavailable; open the URL above)");
		}
	}
}

function readChecks(io: ReleaseIo, sha: string): CheckSummary {
	const result = io.exec(
		"gh",
		[
			"api",
			`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PER_PAGE_MAX}`,
		],
		{ stdio: "capture", timeoutMs: COMMAND_TIMEOUT_MS }
	);
	if (result.status !== 0)
		throw new ReleaseError(
			`Could not read check runs for ${sha.slice(0, 12)} (is it pushed?): ${result.stderr.trim()}`
		);
	return summarizeChecks(parseCheckRuns(result.stdout));
}

export async function waitForChecks(
	io: ReleaseIo,
	sha: string,
	timing: { readonly ciTimeoutMs: number; readonly pollIntervalMs: number }
): Promise<CheckSummary> {
	const deadlineMs = io.nowMs() + timing.ciTimeoutMs;
	let reported = "";
	io.log(`Waiting for checks on ${sha.slice(0, 12)}`);
	for (;;) {
		const summary = readChecks(io, sha);
		const listing = formatChecks(summary.checks);
		if (summary.state !== "pending") {
			io.log(listing);
			if (summary.state === "passed") return summary;
			printFailureLogs(io, summary.failed);
			const names = summary.failed.map((check) => check.name);
			throw new ReleaseError(`CI failed: ${names.join(", ")}.`);
		}
		if (listing !== reported) {
			io.log(listing);
			reported = listing;
		}
		if (io.nowMs() >= deadlineMs)
			throw new ReleaseError(
				`CI did not finish within ${timing.ciTimeoutMs / 60_000} minutes.`
			);
		await io.sleep(timing.pollIntervalMs);
	}
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: CI_WAIT_USAGE,
		parse: () => parseCiWaitOptions(process.argv.slice(2)),
		async run(options) {
			const sha = resolveSha(defaultIo, options.target);
			await waitForChecks(defaultIo, sha, {
				ciTimeoutMs: options.ciTimeoutMs,
				pollIntervalMs: CI_POLL_INTERVAL_MS,
			});
			defaultIo.log("CI passed.");
		},
	});
