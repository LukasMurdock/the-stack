import { execFileSync } from "node:child_process";

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/;

// The commit a build reports from /api/health. `pnpm ship` sets STACK_COMMIT
// and waits for production to serve it.
export function buildCommit(
	env: Readonly<Record<string, string | undefined>> = process.env
): string | null {
	const configured = env.STACK_COMMIT;
	if (configured !== undefined && configured !== "") {
		if (!COMMIT_SHA_PATTERN.test(configured))
			throw new Error(
				`STACK_COMMIT must be a full 40-character commit SHA, got "${configured}".`
			);
		return configured;
	}
	try {
		const head = execFileSync("git", ["rev-parse", "HEAD"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
		return head === "" ? null : head;
	} catch {
		// Outside a git checkout (or without git) the build reports
		// `commit: null`; `pnpm ship` always sets STACK_COMMIT instead.
		return null;
	}
}
