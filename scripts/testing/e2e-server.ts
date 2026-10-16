// An isolated, seeded server for one `pnpm shot --e2e` or `pnpm api --e2e`
// run: the same port claim, fixture state and reusable build as a Playwright
// run, started and stopped around a single command.

import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { CommandError, errorCode } from "../lib/cli.ts";
import { stopProcessTree, waitForHealth } from "../lib/local-server.ts";
import { claimE2EPort, e2ePaths, releaseE2EPort } from "./e2e.ts";

// Covers waiting for another run's checkout lock plus a cold build on a
// loaded machine (about five minutes); beyond this the build is hung.
export const E2E_PREPARE_TIMEOUT_MS = 20 * 60_000;
// Matches Playwright's webServer budget for the preview to answer.
export const E2E_SERVER_READY_TIMEOUT_MS = 300_000;
// Enough of the server log to show the failing build step.
const LOG_TAIL_BYTES = 4_096;

export type E2EServer = {
	readonly origin: string;
	readonly logFile: string;
	readonly stop: () => Promise<void>;
};

export async function startE2EServer(root: string): Promise<E2EServer> {
	const port = await claimE2EPort(undefined);
	const paths = e2ePaths(port, root);
	mkdirSync(paths.directory, { recursive: true });
	const logFile = path.join(paths.directory, "server.log");
	const logFd = openSync(logFile, "w");
	const env = { ...process.env, STACK_E2E_PORT: String(port) };
	let preview: ChildProcess | null = null;
	// A Ctrl-C must not leave a preview holding the port: signal handlers
	// run synchronously, so kill the preview's process group directly.
	const interrupt = (signal: NodeJS.Signals) => {
		if (preview?.pid !== undefined) killGroup(preview.pid);
		releaseE2EPort(port);
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	const stop = async () => {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
		if (preview?.pid !== undefined) await stopProcessTree(preview.pid);
		closeSync(logFd);
		releaseE2EPort(port);
	};
	try {
		process.stderr.write(
			`Preparing an isolated server on port ${port} (log: ${path.relative(root, logFile)}).\n`
		);
		await runToExit(
			spawn(process.execPath, ["scripts/testing/prepare-e2e.ts"], {
				cwd: root,
				env,
				stdio: ["ignore", logFd, logFd],
			}),
			E2E_PREPARE_TIMEOUT_MS
		);
		const started = spawnPreview(root, port, logFd);
		preview = started;
		const health = await waitForHealth(
			`http://127.0.0.1:${port}/api/readiness`,
			{
				timeoutMs: E2E_SERVER_READY_TIMEOUT_MS,
				exited: () => started.exitCode !== null,
			}
		);
		if (!health.ok)
			throw new CommandError(
				`The isolated server on port ${port} did not become ready (${health.error}).`
			);
	} catch (error: unknown) {
		await stop();
		if (!(error instanceof CommandError)) throw error;
		throw new CommandError(
			`${error.message}\nLast lines of ${path.relative(root, logFile)}:\n${logTail(logFile)}`
		);
	}
	// APP_URL in the fixture Worker config; Better Auth trusts this origin.
	return { origin: `http://localhost:${port}`, logFile, stop };
}

function spawnPreview(root: string, port: number, logFd: number): ChildProcess {
	const args = [
		"--port",
		String(port),
		"--host",
		"127.0.0.1",
		"--ignore-lock",
	];
	return spawn(process.execPath, ["scripts/preview.mjs", ...args], {
		cwd: root,
		env: { ...process.env, STACK_E2E: "1", STACK_E2E_PORT: String(port) },
		stdio: ["ignore", logFd, logFd],
		// Leads its own process group so workerd stops with it.
		detached: true,
	});
}

function runToExit(child: ChildProcess, timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(
				new CommandError(
					`Preparing the isolated server took longer than ${timeoutMs / 60_000} minutes.`
				)
			);
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			if (code === 0) {
				resolve();
			} else {
				reject(
					new CommandError(
						`Preparing the isolated server failed (${signal ?? `exit ${code}`}).`
					)
				);
			}
		});
	});
}

function killGroup(pid: number): void {
	try {
		process.kill(-pid, "SIGTERM");
	} catch (error: unknown) {
		// The group already exited.
		if (errorCode(error) !== "ESRCH") throw error;
	}
}

function logTail(file: string): string {
	const sizeBytes = statSync(file).size;
	const lengthBytes = Math.min(sizeBytes, LOG_TAIL_BYTES);
	const buffer = Buffer.alloc(lengthBytes);
	const fd = openSync(file, "r");
	try {
		readSync(fd, buffer, 0, lengthBytes, sizeBytes - lengthBytes);
	} finally {
		closeSync(fd);
	}
	return buffer.toString("utf8");
}
