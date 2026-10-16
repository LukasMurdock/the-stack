import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Astro 7 records the foreground or background dev server here, refuses a
// second server for this checkout, and clears entries whose process exited.
export const devLockPath = (root = process.cwd()) =>
	path.join(root, ".astro", "dev.json");

export function isAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === "EPERM";
	}
}

export function readDevServer(root) {
	try {
		const lock = JSON.parse(readFileSync(devLockPath(root), "utf8"));
		if (!Number.isInteger(lock.pid) || typeof lock.url !== "string")
			return null;
		return {
			...lock,
			url: new URL(lock.url).origin,
			alive: isAlive(lock.pid),
		};
	} catch {
		return null;
	}
}

// Binding without a host claims both IPv4 and IPv6 wildcards, so any listener
// on 127.0.0.1, ::1 or a wildcard address makes the port unavailable.
export function portAvailable(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.once("error", () => resolve(false));
		server.listen({ port, exclusive: true }, () =>
			server.close(() => resolve(true))
		);
	});
}

// Best effort: names the process holding a port when lsof is installed.
export function describePortOwner(port) {
	try {
		const output = execFileSync(
			"lsof",
			["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		);
		const pid = /^p(\d+)$/m.exec(output)?.[1];
		const command = /^c(.+)$/m.exec(output)?.[1];
		return pid ? `pid ${pid}${command ? ` (${command})` : ""}` : null;
	} catch {
		return null;
	}
}

function processTable() {
	return execFileSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat="], {
		encoding: "utf8",
	})
		.trim()
		.split("\n")
		.map((line) => {
			const [pid, ppid, pgid, stat] = line.trim().split(/\s+/);
			return { pid: +pid, ppid: +ppid, pgid: +pgid, stat };
		})
		.filter((row) => !row.stat.startsWith("Z"));
}

// The process, its descendants and, when it leads a process group (Astro's
// background server does), every member of that group, such as workerd.
export function processTree(pid) {
	const table = processTable();
	const tree = new Set([pid]);
	for (const row of table) if (row.pgid === pid) tree.add(row.pid);
	for (let grew = true; grew;) {
		grew = false;
		for (const row of table)
			if (tree.has(row.ppid) && !tree.has(row.pid)) {
				tree.add(row.pid);
				grew = true;
			}
	}
	return [...tree].filter((member) =>
		table.some((row) => row.pid === member)
	);
}

function signal(pids, name) {
	for (const pid of pids)
		try {
			process.kill(pid, name);
		} catch {
			// Already exited.
		}
}

export async function stopProcessTree(pid, graceMs = 5_000) {
	const tree = processTree(pid);
	signal(tree, "SIGTERM");
	const deadline = Date.now() + graceMs;
	let survivors = tree;
	while (survivors.length && Date.now() < deadline) {
		await delay(100);
		const live = new Set(processTable().map((row) => row.pid));
		survivors = survivors.filter((member) => live.has(member));
	}
	signal(survivors, "SIGKILL");
	return { stopped: tree, killed: survivors };
}

// Polls a health endpoint (a URL, or a function returning the current one).
// Each request has its own timeout so a server that accepts connections but
// never answers cannot hang the caller.
export async function waitForHealth(
	url,
	{ timeoutMs = 120_000, requestTimeoutMs = 5_000, intervalMs = 500, exited }
) {
	const deadline = Date.now() + timeoutMs;
	let lastError = "no response";
	while (Date.now() < deadline) {
		if (exited?.()) return { ok: false, error: "server process exited" };
		try {
			const response = await fetch(
				typeof url === "function" ? url() : url,
				{
					signal: AbortSignal.timeout(
						Math.min(requestTimeoutMs, deadline - Date.now())
					),
				}
			);
			if (response.ok) return { ok: true };
			lastError = `HTTP ${response.status}`;
		} catch (error) {
			lastError = error.cause?.code ?? error.name ?? String(error);
		}
		await delay(Math.max(0, Math.min(intervalMs, deadline - Date.now())));
	}
	return { ok: false, error: lastError };
}
