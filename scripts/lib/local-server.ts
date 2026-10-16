import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "./cli.ts";

// ps and lsof answer in milliseconds; lsof can block on network filesystems.
export const PROCESS_QUERY_TIMEOUT_MS = 10_000;
export const STOP_GRACE_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 100;
export const HEALTH_WAIT_TIMEOUT_MS_DEFAULT = 120_000;
export const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
export const HEALTH_POLL_INTERVAL_MS = 500;

// Astro 7 records the foreground or background dev server here, refuses a
// second server for this checkout, and clears entries whose process exited.
export const devLockPath = (root = process.cwd()) =>
	path.join(root, ".astro", "dev.json");

export function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: unknown) {
		// EPERM: the process exists but belongs to another user.
		return errorCode(error) === "EPERM";
	}
}

export type DevServer = {
	readonly pid: number;
	readonly url: string;
	readonly background: boolean;
	readonly alive: boolean;
};

function readLockJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error: unknown) {
		// No lock means no server; a lock Astro is still writing is not
		// valid JSON yet and is treated the same way.
		if (errorCode(error) === "ENOENT") return null;
		if (error instanceof SyntaxError) return null;
		throw new Error(`Could not read ${file}`, { cause: error });
	}
}

export function readDevServer(root?: string): DevServer | null {
	const lock = readLockJson(devLockPath(root));
	if (typeof lock !== "object" || lock === null) return null;
	if (!("pid" in lock) || !("url" in lock)) return null;
	const { pid, url } = lock;
	if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
	if (typeof url !== "string" || !URL.canParse(url)) return null;
	const background = "background" in lock && lock.background === true;
	return { pid, url: new URL(url).origin, background, alive: isAlive(pid) };
}

// Binding without a host claims both IPv4 and IPv6 wildcards, so any listener
// on 127.0.0.1, ::1 or a wildcard address makes the port unavailable.
export function portAvailable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen({ port, exclusive: true }, () =>
			server.close(() => resolve(true))
		);
	});
}

// Best effort: names the process holding a port when lsof is installed.
export function describePortOwner(port: number): string | null {
	let output: string;
	try {
		output = execFileSync(
			"lsof",
			["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: PROCESS_QUERY_TIMEOUT_MS,
			}
		);
	} catch {
		// lsof missing, timed out, or no listener (exit 1). The caller
		// already reports the port as busy; the owner is only a hint.
		return null;
	}
	const pid = /^p(\d+)$/m.exec(output)?.[1];
	const command = /^c(.+)$/m.exec(output)?.[1];
	if (pid === undefined) return null;
	return command === undefined ? `pid ${pid}` : `pid ${pid} (${command})`;
}

type ProcessRow = {
	readonly pid: number;
	readonly ppid: number;
	readonly pgid: number;
};

function processTable(): ProcessRow[] {
	const output = execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
		encoding: "utf8",
		timeout: PROCESS_QUERY_TIMEOUT_MS,
	});
	const rows: ProcessRow[] = [];
	for (const line of output.trim().split("\n")) {
		const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
		if (stat === undefined || stat.startsWith("Z")) continue;
		rows.push({ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid) });
	}
	return rows;
}

// The process, its descendants and, when it leads a process group (Astro's
// background server does), every member of that group, such as workerd.
export function processTree(pid: number): number[] {
	const table = processTable();
	const tree = new Set([pid]);
	for (const row of table) if (row.pgid === pid) tree.add(row.pid);
	// Each pass adds at least one process, so this ends within table.length.
	for (let grew = true; grew;) {
		grew = false;
		for (const row of table)
			if (tree.has(row.ppid) && !tree.has(row.pid)) {
				tree.add(row.pid);
				grew = true;
			}
	}
	const live = new Set(table.map((row) => row.pid));
	return [...tree].filter((member) => live.has(member));
}

function signal(pids: readonly number[], name: NodeJS.Signals): void {
	for (const pid of pids)
		try {
			process.kill(pid, name);
		} catch (error: unknown) {
			// Exited between listing and signalling.
			if (errorCode(error) !== "ESRCH") throw error;
		}
}

export async function stopProcessTree(
	pid: number,
	graceMs = STOP_GRACE_MS
): Promise<{ stopped: number[]; killed: number[] }> {
	const tree = processTree(pid);
	signal(tree, "SIGTERM");
	const deadlineMs = Date.now() + graceMs;
	let survivors = tree;
	while (survivors.length > 0 && Date.now() < deadlineMs) {
		await delay(STOP_POLL_INTERVAL_MS);
		const live = new Set(processTable().map((row) => row.pid));
		survivors = survivors.filter((member) => live.has(member));
	}
	signal(survivors, "SIGKILL");
	return { stopped: tree, killed: survivors };
}

export type HealthWait = {
	readonly timeoutMs?: number;
	readonly requestTimeoutMs?: number;
	readonly pollIntervalMs?: number;
	readonly exited?: () => boolean;
};

function describeRequestError(error: unknown): string {
	if (!(error instanceof Error)) return String(error);
	return errorCode(error.cause) ?? error.name;
}

// Polls a health endpoint (a URL, or a function returning the current one).
// Each request has its own timeout so a server that accepts connections but
// never answers cannot hang the caller.
export async function waitForHealth(
	url: string | (() => string),
	wait: HealthWait
): Promise<{ ok: true } | { ok: false; error: string }> {
	const {
		timeoutMs = HEALTH_WAIT_TIMEOUT_MS_DEFAULT,
		requestTimeoutMs = HEALTH_REQUEST_TIMEOUT_MS,
		pollIntervalMs = HEALTH_POLL_INTERVAL_MS,
	} = wait;
	const deadlineMs = Date.now() + timeoutMs;
	let lastError = "no response";
	while (Date.now() < deadlineMs) {
		if (wait.exited?.() === true)
			return { ok: false, error: "server process exited" };
		try {
			const remainingMs = Math.max(1, deadlineMs - Date.now());
			const response = await fetch(
				typeof url === "function" ? url() : url,
				{
					signal: AbortSignal.timeout(
						Math.min(requestTimeoutMs, remainingMs)
					),
				}
			);
			if (response.ok) return { ok: true };
			lastError = `HTTP ${response.status}`;
		} catch (error: unknown) {
			// Refused or timed out: expected while the server starts.
			lastError = describeRequestError(error);
		}
		const remainingMs = deadlineMs - Date.now();
		await delay(Math.max(0, Math.min(pollIntervalMs, remainingMs)));
	}
	return { ok: false, error: lastError };
}
