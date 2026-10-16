// `pnpm ci:wait [ref|pr]` waits for every GitHub check run on a commit
// (default: HEAD) through the gh CLI, so GH_HOST/GH_TOKEN/GH_REPO apply.
// Exits non-zero on failure or timeout and prints failing jobs' log tails.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import {
	formatChecks,
	parseTarget,
	summarizeChecks,
	failureExcerpt,
} from "./lib/release.mjs";

export class ReleaseError extends Error {}

export const defaultIo = {
	exec(command, args, { inherit = false, env } = {}) {
		const result = spawnSync(command, args, {
			encoding: "utf8",
			env: env ? { ...process.env, ...env } : process.env,
			stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
		});
		if (result.error) throw result.error;
		return {
			status: result.status ?? 1,
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
		};
	},
	fetch: (url, init) => fetch(url, init),
	sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
	now: () => Date.now(),
	log(line) {
		process.stdout.write(`${line}\n`);
	},
};

export function capture(io, command, args) {
	const result = io.exec(command, args);
	if (result.status !== 0)
		throw new ReleaseError(
			`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`
		);
	return result.stdout.trim();
}

export function resolveSha(io, target) {
	if (target.kind === "pr")
		return capture(io, "gh", [
			"pr",
			"view",
			String(target.number),
			"--json",
			"headRefOid",
			"--jq",
			".headRefOid",
		]);
	return capture(io, "git", [
		"rev-parse",
		"--verify",
		`${target.ref}^{commit}`,
	]);
}

function failureLogs(io, failed) {
	for (const check of failed) {
		io.log(
			`\n--- ${check.name}: ${check.conclusion}${check.url ? ` ${check.url}` : ""}`
		);
		if (!check.jobId) continue;
		const log = io.exec("gh", [
			"run",
			"view",
			"--job",
			check.jobId,
			"--log-failed",
		]);
		if (log.status === 0 && log.stdout.trim())
			io.log(failureExcerpt(log.stdout));
		else io.log("(log unavailable; open the URL above)");
	}
}

export async function waitForChecks(
	io,
	sha,
	{ timeoutMs = 30 * 60_000, intervalMs = 10_000 } = {}
) {
	const deadline = io.now() + timeoutMs;
	let reported = "";
	io.log(`Waiting for checks on ${sha.slice(0, 12)}`);
	for (;;) {
		const result = io.exec("gh", [
			"api",
			`repos/{owner}/{repo}/commits/${sha}/check-runs?per_page=100`,
		]);
		if (result.status !== 0)
			throw new ReleaseError(
				`Could not read check runs for ${sha.slice(0, 12)} (is it pushed?): ${result.stderr.trim()}`
			);
		const summary = summarizeChecks(JSON.parse(result.stdout).check_runs);
		const listing = formatChecks(summary.checks);
		if (summary.state !== "pending") {
			io.log(listing);
			if (summary.state === "passed") return summary;
			failureLogs(io, summary.failed);
			throw new ReleaseError(
				`CI failed: ${summary.failed.map((check) => check.name).join(", ")}.`
			);
		}
		if (listing !== reported) {
			io.log(listing);
			reported = listing;
		}
		if (io.now() >= deadline)
			throw new ReleaseError(
				`CI did not finish within ${Math.round(timeoutMs / 60_000)} minutes.`
			);
		await io.sleep(intervalMs);
	}
}

export function minutesOption(args, name, fallback) {
	const index = args.indexOf(name);
	if (index === -1) return fallback;
	const minutes = Number(args[index + 1]);
	if (!(minutes > 0)) throw new ReleaseError(`${name} needs minutes.`);
	args.splice(index, 2);
	return minutes * 60_000;
}

export function reportFailure(error) {
	process.stderr.write(
		`\n${error instanceof ReleaseError ? error.message : error instanceof Error ? error.stack : String(error)}\n`
	);
	process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	try {
		const args = process.argv.slice(2);
		const timeoutMs = minutesOption(args, "--timeout", 30);
		const sha = resolveSha(defaultIo, parseTarget(args[0]));
		await waitForChecks(defaultIo, sha, { timeoutMs });
		defaultIo.log("CI passed.");
	} catch (error) {
		reportFailure(error);
	}
}
