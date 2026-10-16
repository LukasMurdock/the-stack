// Pure decisions for `pnpm ci:wait` and `pnpm ship`, kept apart from gh,
// git, and the network so tooling tests can drive them directly.

function result(run) {
	if (run.status !== "completed") return "pending";
	if (run.conclusion === "success") return "pass";
	return ["skipped", "neutral"].includes(run.conclusion) ? "skip" : "fail";
}

// GitHub check runs -> one verdict. No runs yet, or any unfinished run, is
// "pending": a ref is never reported green before CI has reported. A commit
// can carry several runs per check (push, schedule, re-run); the newest wins.
export function summarizeChecks(runs) {
	const latest = new Map();
	for (const run of runs)
		if (
			!latest.has(run.name) ||
			(latest.get(run.name).id ?? 0) < (run.id ?? 0)
		)
			latest.set(run.name, run);
	const checks = [...latest.values()]
		.map((run) => ({
			name: run.name,
			result: result(run),
			conclusion: run.conclusion ?? run.status,
			jobId: actionsJobId(run),
			url: run.html_url ?? run.details_url ?? null,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
	const failed = checks.filter((check) => check.result === "fail");
	const state =
		checks.length === 0 || checks.some((c) => c.result === "pending")
			? "pending"
			: failed.length
				? "failed"
				: "passed";
	return { state, checks, failed };
}

export function formatChecks(checks) {
	if (!checks.length) return "  (no check runs reported yet)";
	return checks
		.map(
			(check) =>
				`  ${check.result.padEnd(7)} ${check.name}${check.result === "fail" ? ` (${check.conclusion})` : ""}`
		)
		.join("\n");
}

// GitHub Actions check runs link to their job; `gh run view --job` reads its log.
export function actionsJobId(run) {
	if (run.app?.slug && run.app.slug !== "github-actions") return null;
	const match = /\/job\/(\d+)/.exec(run.html_url ?? run.details_url ?? "");
	return match ? match[1] : null;
}

// `gh run view --log-failed` prints "job<TAB>step<TAB>timestamp line" and ends
// with cleanup noise; keep the lines leading up to the last error.
export function failureExcerpt(log, lines = 40) {
	const text = log
		.trimEnd()
		.split("\n")
		.map((line) =>
			line.replace(/^[^\t]*\t[^\t]*\t\d{4}-\d\d-\d\dT[\d:.]+Z ?/, "")
		);
	const lastError = text.findLastIndex((line) => line.includes("##[error]"));
	const end = lastError === -1 ? text.length : lastError + 1;
	return text.slice(Math.max(0, end - lines), end).join("\n");
}

// `pnpm ci:wait 12` / `#12` waits on a PR head; anything else is a git ref.
export function parseTarget(arg) {
	if (!arg) return { kind: "ref", ref: "HEAD" };
	const pr = /^#?(\d+)$/.exec(arg);
	return pr
		? { kind: "pr", number: Number(pr[1]) }
		: { kind: "ref", ref: arg };
}

// What `pnpm ship` does with a PR from `gh pr view`. A merged PR resumes at
// the deploy, so rerunning after a failure never merges twice.
export function mergeAction(pr) {
	if (pr.state === "MERGED") return "resume";
	if (pr.state !== "OPEN")
		throw new Error(`PR #${pr.number} is closed without merging.`);
	if (pr.isDraft) throw new Error(`PR #${pr.number} is a draft.`);
	return "merge";
}

export function productionOrigin(config) {
	const url = config.vars?.APP_URL;
	if (!url) throw new Error("config/cloudflare.mjs has no APP_URL.");
	const parsed = new URL(url);
	if (parsed.hostname.endsWith(".example") || parsed.protocol !== "https:")
		throw new Error(
			`Set deploymentCloudflare.vars.APP_URL in config/cloudflare.mjs to your production HTTPS origin (now ${url}).`
		);
	return parsed.origin;
}

// Cloudflare can route some requests to the previous version while a deploy
// propagates, so the new commit must be served several times in a row.
export const liveConfirmations = 3;

export function servedCommit(health) {
	return health && typeof health === "object" && "commit" in health
		? (health.commit ?? null)
		: null;
}

export function releaseSummary({ origin, adminEmail }) {
	return [
		`Production: ${origin}`,
		`Sign in:    ${origin}/app/login`,
		`Admin:      ${adminEmail} (ADMIN_EMAIL in config/cloudflare.mjs).`,
		"            First deploy: POST /api/internal/bootstrap-admin with header",
		"            x-bootstrap-secret: <BOOTSTRAP_SECRET> (set with `void secret put`);",
		"            it emails ADMIN_EMAIL a link to set the password. No password is stored.",
	].join("\n");
}
