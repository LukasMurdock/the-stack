// `pnpm ship <pr>` releases one pull request: wait for its CI, merge it,
// fast-forward the base branch, run `scripts/deploy.mjs`, then wait until
// production's /api/health serves the deployed commit. Running it is the
// operator's production approval. Rerunning resumes: a merged PR skips the
// merge, and a commit production already serves skips the deploy.

import { pathToFileURL } from "node:url";
import { deploymentCloudflare } from "../config/cloudflare.mjs";
import {
	ReleaseError,
	capture,
	defaultIo,
	minutesOption,
	reportFailure,
	waitForChecks,
} from "./ci-wait.mjs";
import {
	liveConfirmations,
	mergeAction,
	productionOrigin,
	releaseSummary,
	servedCommit,
} from "./lib/release.mjs";

async function readHealth(io, origin) {
	try {
		const response = await io.fetch(`${origin}/api/health`, {
			cache: "no-store",
		});
		return response.ok ? await response.json() : null;
	} catch {
		return null;
	}
}

async function waitUntilLive(io, origin, commit, timeoutMs) {
	const deadline = io.now() + timeoutMs;
	let streak = 0;
	let health = null;
	while (streak < liveConfirmations) {
		health = await readHealth(io, origin);
		streak = servedCommit(health) === commit ? streak + 1 : 0;
		if (streak >= liveConfirmations) break;
		if (io.now() >= deadline)
			throw new ReleaseError(
				`Production serves ${servedCommit(health) ?? "no commit"}; expected ${commit}.`
			);
		await io.sleep(streak ? 1_000 : 5_000);
	}
	const readiness = await io.fetch(`${origin}/api/readiness`, {
		cache: "no-store",
	});
	if (!readiness.ok)
		throw new ReleaseError(`/api/readiness returned ${readiness.status}.`);
	return health;
}

function run(io, command, args, env) {
	const result = io.exec(command, args, { inherit: true, env });
	if (result.status !== 0)
		throw new ReleaseError(
			`${command} ${args.join(" ")} exited with ${result.status}.`
		);
}

/**
 * @param {typeof defaultIo} io
 * @param {number} number
 * @param {{ config?: { vars: { APP_URL?: string; ADMIN_EMAIL?: string } }; mergeMethod?: string; ciTimeoutMs?: number; liveTimeoutMs?: number }} [options]
 */
export async function ship(
	io,
	number,
	{
		config = deploymentCloudflare,
		mergeMethod = "--merge",
		ciTimeoutMs = 30 * 60_000,
		liveTimeoutMs = 5 * 60_000,
	} = {}
) {
	const step = (message) => io.log(`\n==> ${message}`);
	const origin = productionOrigin(config);
	// A failed deploy can leave newly recorded resource IDs; keep them so
	// the rerun reuses those resources (commit void.lock.json afterwards).
	const changes = capture(io, "git", ["status", "--porcelain"])
		.split("\n")
		.filter((line) => line && !line.endsWith(" void.lock.json"));
	if (changes.length)
		throw new ReleaseError(
			`Commit or stash local changes before shipping:\n${changes.join("\n")}`
		);

	const view = () =>
		JSON.parse(
			capture(io, "gh", [
				"pr",
				"view",
				String(number),
				"--json",
				"number,title,url,state,isDraft,baseRefName,headRefOid,mergeCommit",
			])
		);
	let pr = view();
	io.log(`PR #${pr.number}: ${pr.title}\n${pr.url}`);

	if (mergeAction(pr) === "merge") {
		step("Waiting for CI");
		await waitForChecks(io, pr.headRefOid, { timeoutMs: ciTimeoutMs });
		step("Merging");
		// Refuses to merge if the head moved after the checks passed.
		run(io, "gh", [
			"pr",
			"merge",
			String(number),
			mergeMethod,
			"--match-head-commit",
			pr.headRefOid,
		]);
		pr = view();
		if (pr.state !== "MERGED")
			throw new ReleaseError(
				`PR #${number} is ${pr.state} after merging (auto-merge or a merge queue?). Rerun once it merges.`
			);
	} else io.log("Already merged; resuming at the deploy.");

	const base = pr.baseRefName;
	const mergeSha = pr.mergeCommit?.oid;
	if (!mergeSha) throw new ReleaseError(`PR #${number} has no merge commit.`);
	step(`Fast-forwarding ${base}`);
	run(io, "git", ["fetch", "origin", base]);
	run(io, "git", ["checkout", base]);
	run(io, "git", ["merge", "--ff-only", `origin/${base}`]);
	// Later merges ship too, but never a checkout without this PR.
	if (
		io.exec("git", ["merge-base", "--is-ancestor", mergeSha, "HEAD"]).status
	)
		throw new ReleaseError(`${base} does not contain ${mergeSha}.`);
	const commit = capture(io, "git", ["rev-parse", "HEAD"]);

	if (servedCommit(await readHealth(io, origin)) === commit)
		io.log(
			`Production already serves ${commit.slice(0, 12)}; skipping the deploy.`
		);
	else {
		run(io, "pnpm", ["install", "--frozen-lockfile"]);
		step("Deploying (scripts/deploy.mjs)");
		run(io, "node", ["scripts/deploy.mjs"], {
			STACK_COMMIT: commit,
			STACK_SHIP: "1",
		});
	}

	step(`Waiting for ${origin} to serve ${commit.slice(0, 12)}`);
	const health = await waitUntilLive(io, origin, commit, liveTimeoutMs);
	io.log(
		`\nShipped PR #${number} at ${commit.slice(0, 12)} (Worker version ${health?.version ?? "unknown"}).`
	);
	io.log(releaseSummary({ origin, adminEmail: config.vars.ADMIN_EMAIL }));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const args = process.argv.slice(2);
	try {
		const ciTimeoutMs = minutesOption(args, "--timeout", 30);
		const mergeMethod =
			args.find((arg) =>
				["--merge", "--squash", "--rebase"].includes(arg)
			) ?? "--merge";
		const number = Number(
			args.find((arg) => /^#?\d+$/.test(arg))?.replace("#", "")
		);
		if (!Number.isInteger(number) || number <= 0)
			throw new ReleaseError(
				"Usage: pnpm ship <pr> [--merge|--squash|--rebase] [--timeout <minutes>]"
			);
		await ship(defaultIo, number, { mergeMethod, ciTimeoutMs });
	} catch (error) {
		reportFailure(error);
	}
}
