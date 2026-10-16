// `pnpm dev` / `pnpm dev:stop` / `pnpm dev:wait`: one dev server per
// checkout, stopped by its recorded process tree, waited for by health.

import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseBoundedInteger,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	describePortOwner,
	devLockPath,
	isAlive,
	portAvailable,
	readDevServer,
	stopProcessTree,
	waitForHealth,
} from "./lib/local-server.ts";
import { loadLocalEnv } from "./local-env.mjs";

export const DEV_PORT_DEFAULT = 4321;
export const DEV_WAIT_TIMEOUT_SECONDS_DEFAULT = 120;
// A cold start on a loaded machine takes minutes, not hours.
export const DEV_WAIT_TIMEOUT_SECONDS_MAX = 60 * 60;
const TCP_PORT_MAX = 65_535;

export const DEV_SERVER_USAGE = `Usage: pnpm dev [--port <port>] [astro dev flags]
       pnpm dev:stop
       pnpm dev:wait [--timeout <seconds>]

  start  Start astro dev unless this checkout's server or another process
         holds the port (default ${DEV_PORT_DEFAULT}). Also accepts astro dev's
         --host [address], --open, --force, --background, --mode <mode>,
         --allowed-hosts <hosts>.
  stop   Stop this checkout's dev server and its process tree.
  wait   Poll /api/health until it answers, for up to --timeout whole
         seconds (default ${DEV_WAIT_TIMEOUT_SECONDS_DEFAULT}, max ${DEV_WAIT_TIMEOUT_SECONDS_MAX}).`;

export type DevServerOptions =
	| {
			readonly command: "start";
			readonly port: number;
			// Validated astro dev flags, forwarded unchanged.
			readonly astroArgs: readonly string[];
	  }
	| { readonly command: "stop" }
	| { readonly command: "wait"; readonly devWaitTimeoutMs: number };

function parsePort(value: string): number {
	return parseBoundedInteger(value, {
		name: "--port",
		min: 1,
		max: TCP_PORT_MAX,
	});
}

// astro dev's `--host` takes an optional address, which parseArgs cannot
// express; a bare `--host` is validated as `--host=` and forwarded as typed.
function withExplicitHostValues(argv: readonly string[]): string[] {
	return argv.map((arg, index) => {
		if (arg !== "--host") return arg;
		const next = argv[index + 1];
		return next === undefined || next.startsWith("-") ? "--host=" : arg;
	});
}

function parseStart(argv: readonly string[]): Command<DevServerOptions> {
	const { values, positionals } = parseCommandLine(
		withExplicitHostValues(argv),
		{
			port: { type: "string" },
			host: { type: "string" },
			open: { type: "boolean" },
			force: { type: "boolean" },
			background: { type: "boolean" },
			mode: { type: "string" },
			"allowed-hosts": { type: "string" },
			help: { type: "boolean", short: "h" },
		}
	);
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${positionals.join(" ")}.`);
	const port =
		values.port === undefined ? DEV_PORT_DEFAULT : parsePort(values.port);
	return {
		kind: "run",
		options: { command: "start", port, astroArgs: argv },
	};
}

function parseWait(argv: readonly string[]): Command<DevServerOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		timeout: { type: "string" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${positionals.join(" ")}.`);
	const timeoutSeconds =
		values.timeout === undefined
			? DEV_WAIT_TIMEOUT_SECONDS_DEFAULT
			: parseBoundedInteger(values.timeout, {
					name: "--timeout (seconds)",
					min: 1,
					max: DEV_WAIT_TIMEOUT_SECONDS_MAX,
				});
	return {
		kind: "run",
		options: { command: "wait", devWaitTimeoutMs: timeoutSeconds * 1_000 },
	};
}

export function parseDevServerOptions(
	argv: readonly string[]
): Command<DevServerOptions> {
	const [command = "start", ...rest] = argv;
	switch (command) {
		case "start":
			return parseStart(rest);
		case "wait":
			return parseWait(rest);
		case "stop": {
			const { values, positionals } = parseCommandLine(rest, {
				help: { type: "boolean", short: "h" },
			});
			if (values.help === true) return { kind: "help" };
			if (positionals.length > 0)
				throw new UsageError(
					`Unexpected argument: ${positionals.join(" ")}.`
				);
			return { kind: "run", options: { command: "stop" } };
		}
		case "-h":
		case "--help":
			return { kind: "help" };
		default:
			throw new UsageError(
				`Unknown command: ${command}. Use start, stop or wait.`
			);
	}
}

// Refuse before Astro starts: a second server for this checkout, or any other
// process on the port, would otherwise hang or silently move to another port.
async function start(
	port: number,
	astroArgs: readonly string[]
): Promise<void> {
	const existing = readDevServer();
	if (existing?.alive === true)
		throw new CommandError(
			`Dev server already running at ${existing.url} (pid ${existing.pid}).\nStop it with \`pnpm dev:stop\`, or wait for it with \`pnpm dev:wait\`.`
		);
	if (existing !== null) {
		rmSync(devLockPath(), { force: true });
		process.stdout.write(
			`Removed stale dev server lock (pid ${existing.pid} exited).\n`
		);
	}
	if (!(await portAvailable(port))) {
		const owner = describePortOwner(port);
		throw new CommandError(
			`Port ${port} is already in use${owner === null ? "" : ` by ${owner}`}, which is not this checkout's dev server.\nStop that process by PID, or run \`pnpm dev --port <port>\` and set APP_URL to match.`
		);
	}
	const astro = spawn("pnpm", ["exec", "astro", "dev", ...astroArgs], {
		stdio: "inherit",
	});
	for (const name of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
		process.on(name, () => astro.kill(name));
	astro.on("exit", (code, signal) =>
		process.exit(code ?? (signal === null ? 1 : 128))
	);
}

async function stop(): Promise<void> {
	const server = readDevServer();
	if (server === null) {
		rmSync(devLockPath(), { force: true });
		process.stdout.write("No dev server is running for this checkout.\n");
		return;
	}
	// A background server leads its process group, so workerd orphaned by a
	// crashed astro process is still found through a stale lock.
	const { stopped, killed } = await stopProcessTree(server.pid);
	rmSync(devLockPath(), { force: true });
	if (stopped.length === 0) {
		process.stdout.write("No dev server is running for this checkout.\n");
		return;
	}
	const forced = killed.length > 0 ? `, ${killed.length} force-killed` : "";
	process.stdout.write(
		`Stopped dev server at ${server.url} (pid ${server.pid}, ${stopped.length} processes${forced}).\n`
	);
}

function configuredOrigin(appUrl: string | undefined): string {
	const url =
		appUrl === undefined || appUrl === ""
			? `http://localhost:${DEV_PORT_DEFAULT}`
			: appUrl;
	if (!URL.canParse(url))
		throw new CommandError(`APP_URL is not a URL: ${url}`);
	return new URL(url).origin;
}

async function wait(devWaitTimeoutMs: number): Promise<void> {
	loadLocalEnv();
	const fallbackOrigin = configuredOrigin(process.env.APP_URL);
	const startedMs = Date.now();
	// A foreground server records itself only once listening, so re-read the
	// lock on each attempt; once seen, its exit ends the wait early.
	let origin = fallbackOrigin;
	let seenPid: number | undefined;
	const result = await waitForHealth(
		() => {
			const server = readDevServer();
			if (server?.alive === true) seenPid = server.pid;
			origin = server?.alive === true ? server.url : fallbackOrigin;
			return `${origin}/api/health`;
		},
		{
			timeoutMs: devWaitTimeoutMs,
			exited: () => seenPid !== undefined && !isAlive(seenPid),
		}
	);
	const seconds = ((Date.now() - startedMs) / 1_000).toFixed(1);
	if (!result.ok)
		throw new CommandError(
			`Dev server at ${origin} was not healthy after ${seconds}s (${result.error}). Check \`pnpm exec astro dev logs\` or the dev terminal.`
		);
	process.stdout.write(`Dev server healthy at ${origin} (${seconds}s).\n`);
}

export function runDevServer(options: DevServerOptions): Promise<void> {
	switch (options.command) {
		case "start":
			return start(options.port, options.astroArgs);
		case "stop":
			return stop();
		case "wait":
			return wait(options.devWaitTimeoutMs);
	}
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: DEV_SERVER_USAGE,
		parse: () => parseDevServerOptions(process.argv.slice(2)),
		run: runDevServer,
	});
