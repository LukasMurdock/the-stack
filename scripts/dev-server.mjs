import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
	describePortOwner,
	devLockPath,
	isAlive,
	portAvailable,
	readDevServer,
	stopProcessTree,
	waitForHealth,
} from "./lib/local-server.mjs";
import { loadLocalEnv } from "./local-env.mjs";

const [command = "start", ...args] = process.argv.slice(2);

function flag(name) {
	const index = args.findIndex(
		(arg) => arg === name || arg.startsWith(`${name}=`)
	);
	if (index === -1) return undefined;
	return args[index].includes("=")
		? args[index].slice(name.length + 1)
		: args[index + 1];
}

function fail(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

// Refuse before Astro starts: a second server for this checkout, or any other
// process on the port, would otherwise hang or silently move to another port.
async function start() {
	const existing = readDevServer();
	if (existing?.alive)
		fail(
			`Dev server already running at ${existing.url} (pid ${existing.pid}).\nStop it with \`pnpm dev:stop\`, or wait for it with \`pnpm dev:wait\`.`
		);
	if (existing) {
		rmSync(devLockPath(), { force: true });
		process.stdout.write(
			`Removed stale dev server lock (pid ${existing.pid} exited).\n`
		);
	}
	const port = Number(flag("--port") ?? 4321);
	if (!(await portAvailable(port))) {
		const owner = describePortOwner(port);
		fail(
			`Port ${port} is already in use${owner ? ` by ${owner}` : ""}, which is not this checkout's dev server.\nStop that process by PID, or run \`pnpm dev --port <port>\` and set APP_URL to match.`
		);
	}
	const astro = spawn("pnpm", ["exec", "astro", "dev", ...args], {
		stdio: "inherit",
	});
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"])
		process.on(name, () => astro.kill(name));
	astro.on("exit", (code, signal) =>
		process.exit(code ?? (signal ? 128 : 1))
	);
}

async function stop() {
	const server = readDevServer();
	// A background server leads its process group, so workerd orphaned by a
	// crashed astro process is still found through a stale lock.
	const { stopped, killed } = server
		? await stopProcessTree(server.pid)
		: { stopped: [] };
	rmSync(devLockPath(), { force: true });
	if (!stopped.length) {
		process.stdout.write("No dev server is running for this checkout.\n");
		return;
	}
	process.stdout.write(
		`Stopped dev server at ${server.url} (pid ${server.pid}, ${stopped.length} processes${killed.length ? `, ${killed.length} force-killed` : ""}).\n`
	);
}

async function wait() {
	loadLocalEnv();
	const timeoutSeconds = Number(flag("--timeout") ?? 120);
	const started = Date.now();
	// A foreground server records itself only once listening, so re-read the
	// lock on each attempt; once seen, its exit ends the wait early.
	let origin;
	let seen;
	const result = await waitForHealth(
		() => {
			const server = readDevServer();
			if (server?.alive) seen = server.pid;
			origin = new URL(
				(server?.alive && server.url) ||
					process.env.APP_URL ||
					"http://localhost:4321"
			).origin;
			return `${origin}/api/health`;
		},
		{
			timeoutMs: timeoutSeconds * 1_000,
			exited: () => seen !== undefined && !isAlive(seen),
		}
	);
	const seconds = ((Date.now() - started) / 1_000).toFixed(1);
	if (!result.ok)
		fail(
			`Dev server at ${origin} was not healthy after ${seconds}s (${result.error}). Check \`pnpm exec astro dev logs\` or the dev terminal.`
		);
	process.stdout.write(`Dev server healthy at ${origin} (${seconds}s).\n`);
}

const commands = { start, stop, wait };
if (!(command in commands))
	fail(`Unknown command: ${command}. Use start, stop or wait.`);
await commands[command]();
