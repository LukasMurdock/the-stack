import { execFileSync } from "node:child_process";

// The commit a build reports from /api/health. `pnpm ship` sets STACK_COMMIT
// and waits for production to serve it.
/** @param {Record<string, string | undefined>} [env] */
export function buildCommit(env = process.env) {
	if (env.STACK_COMMIT) return env.STACK_COMMIT;
	try {
		return (
			execFileSync("git", ["rev-parse", "HEAD"], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			}).trim() || null
		);
	} catch {
		return null;
	}
}
