import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { isAlive, stopProcessTree } from "../../scripts/lib/local-server.mjs";
import {
	buildFingerprint,
	claimE2EPort,
	releaseE2EPort,
	stampMatches,
} from "../../scripts/testing/e2e.mjs";

const devServer = path.resolve("scripts/dev-server.mjs");

function temporaryDirectory(t: test.TestContext, prefix: string) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

async function listen(server: Server) {
	await new Promise<void>((resolve) => server.listen(0, resolve));
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Expected a TCP address.");
	return address.port;
}

// A parent with a child and grandchild, standing in for astro dev -> workerd.
// Resolves the three PIDs once all are running.
async function processTree(
	t: test.TestContext,
	{ leafIgnoresTerm = false, detached = false } = {}
) {
	const leaf = `${leafIgnoresTerm ? 'process.on("SIGTERM", () => {});' : ""} console.log(process.pid); setInterval(() => {}, 1000);`;
	const middle = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(leaf)}], { stdio: ["ignore", "inherit", "inherit"] }); console.log(process.pid); setInterval(() => {}, 1000);`;
	const root = spawn(
		process.execPath,
		[
			"-e",
			`require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(middle)}], { stdio: ["ignore", "inherit", "inherit"] }); setInterval(() => {}, 1000);`,
		],
		{ stdio: ["ignore", "pipe", "inherit"], detached }
	);
	t.after(() => {
		for (const pid of pids) if (isAlive(pid)) process.kill(pid, "SIGKILL");
	});
	const pids: number[] = [root.pid ?? 0];
	let output = "";
	root.stdout.on("data", (chunk: Buffer) => (output += chunk));
	while (output.trim().split("\n").length < 2) await delay(50);
	pids.push(...output.trim().split("\n").map(Number));
	return pids;
}

function stopRecorded(t: test.TestContext, pid: number) {
	const root = temporaryDirectory(t, "stack-dev-stop-");
	mkdirSync(path.join(root, ".astro"));
	const lock = path.join(root, ".astro", "dev.json");
	writeFileSync(lock, JSON.stringify({ pid, url: "http://localhost:4321/" }));
	const result = spawnSync(process.execPath, [devServer, "stop"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.throws(() => readFileSync(lock));
	return result.stdout;
}

test("dev:stop stops the recorded server's whole process tree", async (t) => {
	const pids = await processTree(t);
	assert.match(stopRecorded(t, pids[0]), /pid \d+, 3 processes\)/);
	await delay(100);
	assert.deepEqual(
		pids.filter((pid) => isAlive(pid)),
		[]
	);
});

// Astro escalates to SIGKILL, which orphans workerd; the background server's
// process group still identifies it.
test("dev:stop reaps the process group of a crashed background server", async (t) => {
	const [leader, ...orphans] = await processTree(t, { detached: true });
	process.kill(leader, "SIGKILL");
	while (isAlive(leader)) await delay(20);
	assert.match(stopRecorded(t, leader), /2 processes\)/);
	await delay(100);
	assert.deepEqual(
		orphans.filter((pid) => isAlive(pid)),
		[]
	);
});

test("stopProcessTree escalates to SIGKILL after the grace period", async (t) => {
	const pids = await processTree(t, { leafIgnoresTerm: true });
	const { stopped, killed } = await stopProcessTree(pids[0], 300);
	assert.deepEqual([...stopped].sort(), [...pids].sort());
	assert.deepEqual(killed, [pids[2]]);
});

test("pnpm dev refuses a live server, clears a stale lock and fails fast on a busy port", async (t) => {
	const root = temporaryDirectory(t, "stack-dev-start-");
	mkdirSync(path.join(root, ".astro"));
	const lock = path.join(root, ".astro", "dev.json");
	writeFileSync(
		lock,
		JSON.stringify({ pid: process.pid, url: "http://localhost:4999/" })
	);
	const live = spawnSync(process.execPath, [devServer, "start"], {
		cwd: root,
		encoding: "utf8",
	});
	assert.equal(live.status, 1);
	assert.match(
		live.stderr,
		new RegExp(
			`already running at http://localhost:4999 \\(pid ${process.pid}\\)`
		)
	);

	const busy = createServer();
	t.after(() => busy.close());
	const port = await listen(busy);
	const exited = spawn(process.execPath, ["-e", ""]);
	await new Promise((resolve) => exited.on("exit", resolve));
	writeFileSync(
		lock,
		JSON.stringify({ pid: exited.pid, url: "http://localhost:4999/" })
	);
	const stale = spawnSync(
		process.execPath,
		[devServer, "start", "--port", String(port)],
		{ cwd: root, encoding: "utf8" }
	);
	assert.equal(stale.status, 1);
	assert.match(stale.stdout, /Removed stale dev server lock/);
	assert.match(stale.stderr, new RegExp(`Port ${port} is already in use`));
	assert.throws(() => readFileSync(lock));
});

test("dev:wait bounds each health request and the overall deadline", async (t) => {
	const healthy = createServer((request, response) => {
		response.statusCode = request.url === "/api/health" ? 200 : 404;
		response.end();
	});
	// Accepts connections but never answers, like a wedged dev server.
	const hung = createServer(() => {});
	t.after(() => {
		healthy.close();
		hung.closeAllConnections();
		hung.close();
	});
	const run = async (port: number, recordedPort?: number) => {
		const cwd = temporaryDirectory(t, "stack-dev-wait-");
		const started = Date.now();
		const child = spawn(
			process.execPath,
			[devServer, "wait", "--timeout", "3"],
			{
				cwd,
				env: { ...process.env, APP_URL: `http://localhost:${port}` },
			}
		);
		// A foreground server records itself only after it starts listening.
		if (recordedPort) {
			await delay(500);
			mkdirSync(path.join(cwd, ".astro"));
			writeFileSync(
				path.join(cwd, ".astro", "dev.json"),
				JSON.stringify({
					pid: process.pid,
					url: `http://localhost:${recordedPort}/`,
				})
			);
		}
		const status = await new Promise((resolve) =>
			child.on("exit", resolve)
		);
		return { status, seconds: (Date.now() - started) / 1000 };
	};
	const healthyPort = await listen(healthy);
	const hungPort = await listen(hung);
	assert.equal((await run(healthyPort)).status, 0);
	const closed = createServer();
	const closedPort = await listen(closed);
	await new Promise((resolve) => closed.close(resolve));
	assert.equal((await run(closedPort, healthyPort)).status, 0);
	const timedOut = await run(hungPort);
	assert.equal(timedOut.status, 1);
	assert.ok(timedOut.seconds < 10, `waited ${timedOut.seconds}s`);
});

test("browser runs claim distinct ports and reject a busy explicit port", async (t) => {
	const registry = temporaryDirectory(t, "stack-e2e-ports-");
	const busy = createServer();
	t.after(() => busy.close());
	const taken = await listen(busy);
	await assert.rejects(
		claimE2EPort(String(taken), { registry }),
		new RegExp(`STACK_E2E_PORT=${taken} is already in use`)
	);

	// A free port claimed by another live run is skipped; a dead run's claim
	// is reclaimed.
	const probe = createServer();
	const first = await listen(probe);
	await new Promise((resolve) => probe.close(resolve));
	writeFileSync(path.join(registry, `${first}.pid`), String(process.ppid));
	const second = await claimE2EPort(undefined, { registry, first });
	assert.notEqual(second, first);
	await assert.rejects(
		claimE2EPort(String(first), { registry }),
		/in use by another browser test run/
	);
	const exited = spawn(process.execPath, ["-e", ""]);
	await new Promise((resolve) => exited.on("exit", resolve));
	writeFileSync(path.join(registry, `${first}.pid`), String(exited.pid));
	assert.equal(await claimE2EPort(String(first), { registry }), first);
	releaseE2EPort(first, registry);
	assert.throws(() => readFileSync(path.join(registry, `${first}.pid`)));
});

test("the E2E build fingerprint tracks build inputs, not tests", (t) => {
	const root = temporaryDirectory(t, "stack-e2e-fingerprint-");
	assert.equal(buildFingerprint(root), null);
	const git = (...args: string[]) =>
		execFileSync("git", args, { cwd: root, stdio: "ignore" });
	git("init", "-q");
	mkdirSync(path.join(root, "src"));
	mkdirSync(path.join(root, "tests"));
	writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
	writeFileSync(path.join(root, "src", "page.ts"), "one");
	writeFileSync(path.join(root, "tests", "page.test.ts"), "one");
	git("add", ".");
	const initial = buildFingerprint(root);
	assert.match(initial ?? "", /^[0-9a-f]{64}$/);
	assert.notEqual(buildFingerprint(root, "port 5000"), initial);

	writeFileSync(path.join(root, "tests", "page.test.ts"), "two");
	writeFileSync(path.join(root, "README.md"), "docs");
	writeFileSync(path.join(root, "ignored.txt"), "local");
	assert.equal(buildFingerprint(root), initial);

	writeFileSync(path.join(root, "src", "page.ts"), "two");
	const edited = buildFingerprint(root);
	assert.notEqual(edited, initial);
	writeFileSync(path.join(root, "src", "new.ts"), "untracked");
	const added = buildFingerprint(root);
	assert.notEqual(added, edited);
	rmSync(path.join(root, "src", "page.ts"));
	assert.notEqual(buildFingerprint(root), added);

	const stamp = path.join(root, "stamp.json");
	writeFileSync(stamp, JSON.stringify({ fingerprint: initial }));
	assert.equal(stampMatches(stamp, initial), true);
	assert.equal(stampMatches(stamp, edited), false);
	assert.equal(stampMatches(stamp, null), false);
	process.env.STACK_E2E_REBUILD = "1";
	t.after(() => delete process.env.STACK_E2E_REBUILD);
	assert.equal(stampMatches(stamp, initial), false);
});
