import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { errorCode } from "../lib/cli.ts";
import {
	describePortOwner,
	isAlive,
	portAvailable,
} from "../lib/local-server.ts";

export const defaultE2EPort = 4322;
// Candidate ports scanned from defaultE2EPort when none is requested.
export const E2E_PORT_CANDIDATES_COUNT = 100;
const E2E_PORT_MIN = 1024;
const E2E_PORT_MAX = 65_535;
// An empty claim file younger than this is still being written by its owner.
const CLAIM_WRITE_GRACE_MS = 5_000;
// Each attempt either claims, finds a live holder, or removes a stale claim;
// more than a few rounds means another process keeps racing us.
const CLAIM_ATTEMPTS_MAX = 10;
const CHECKOUT_LOCK_POLL_INTERVAL_MS = 250;
// A cold build on a loaded machine takes about five minutes; a holder
// beyond this is hung and must be stopped by PID.
export const CHECKOUT_LOCK_WAIT_MS_MAX = 15 * 60_000;

// Everything a browser run writes is keyed by port, so parallel runs in one
// checkout never share D1 state, Worker config or build output.
export function e2ePaths(port: number, root = process.cwd()) {
	const directory = path.join(root, ".wrangler", "e2e", String(port));
	return {
		directory,
		config: path.join(directory, "wrangler.json"),
		state: path.join(directory, "state"),
		outDir: path.join(directory, "dist"),
		// Astro empties outDir before building, removing a stale stamp.
		buildStamp: path.join(directory, "dist", "e2e-build.json"),
		deployConfig: path.join(directory, "dist", "deploy-config.json"),
		stateTemplate: path.join(directory, "state-template"),
		stateStamp: path.join(directory, "state-template.json"),
	};
}

// STACK_E2E_PORT -> a port. Digits only: Number() would accept "0x10e2".
export function parsePort(value: string | number): number {
	const text = String(value);
	const port = Number(text);
	if (!/^\d+$/.test(text) || port < E2E_PORT_MIN || port > E2E_PORT_MAX)
		throw new Error(
			`STACK_E2E_PORT must be an integer between ${E2E_PORT_MIN} and ${E2E_PORT_MAX}, got "${text}".`
		);
	return port;
}

// The port a browser build or preview belongs to (STACK_E2E_PORT, or the
// default when run outside the Playwright runner).
export function e2ePortFromEnv(
	env: Readonly<Record<string, string | undefined>>
): number {
	return parsePort(env.STACK_E2E_PORT ?? defaultE2EPort);
}

// Files that cannot change the Worker or client bundle. Everything else
// tracked or untracked-but-not-ignored invalidates the E2E build.
const nonBuildInputs =
	/^(?:tests|docs|tools|\.github|\.husky|\.agents|\.vscode)\/|^[^/]+\.md$|^(?:LICENSE|justfile)$/;

function buildInputFiles(root: string): string[] | null {
	let listing: string;
	try {
		listing = execFileSync(
			"git",
			["ls-files", "-z", "-c", "-o", "--exclude-standard"],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		);
	} catch {
		// Not a git checkout: callers treat a null fingerprint as "always
		// rebuild", which is slower but never stale.
		return null;
	}
	const files = listing
		.split("\0")
		.filter((file) => file !== "" && !nonBuildInputs.test(file));
	return [...new Set(files)].sort();
}

// Content hash of the build inputs. Returns null outside a Git checkout, which
// callers treat as "always rebuild".
export function buildFingerprint(
	root = process.cwd(),
	extra = ""
): string | null {
	const files = buildInputFiles(root);
	if (files === null) return null;
	const hash = createHash("sha256").update(extra);
	for (const file of files) {
		hash.update(`\0${file}\0`);
		try {
			hash.update(readFileSync(path.join(root, file)));
		} catch (error: unknown) {
			// A tracked file deleted in the worktree, or a submodule
			// directory: hash its absence so the change still counts.
			const code = errorCode(error);
			if (code !== "ENOENT" && code !== "EISDIR") throw error;
			hash.update("\0deleted");
		}
	}
	return hash.digest("hex");
}

export type StampCheck = { readonly rebuild: boolean };

// Stamps are written after their artifact is complete and record the
// fingerprint of the inputs it was produced from.
export function stampMatches(
	file: string,
	fingerprint: string | null,
	check: StampCheck
): boolean {
	if (fingerprint === null || check.rebuild) return false;
	let stamp: unknown;
	try {
		stamp = JSON.parse(readFileSync(file, "utf8"));
	} catch (error: unknown) {
		// Missing or partly written stamp: rebuild, which is always safe.
		if (errorCode(error) === "ENOENT") return false;
		if (error instanceof SyntaxError) return false;
		throw error;
	}
	return (
		typeof stamp === "object" &&
		stamp !== null &&
		"fingerprint" in stamp &&
		stamp.fingerprint === fingerprint
	);
}

type ClaimAttempt = "claimed" | "held" | "retry";

function claimOnce(file: string, owner: number): ClaimAttempt {
	try {
		writeFileSync(file, String(owner), { flag: "wx" });
		return "claimed";
	} catch (error: unknown) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	let holder: number;
	let ageMs: number;
	try {
		holder = Number(readFileSync(file, "utf8"));
		ageMs = Date.now() - statSync(file).mtimeMs;
	} catch (error: unknown) {
		// Released between our write and read: try again.
		if (errorCode(error) === "ENOENT") return "retry";
		throw error;
	}
	if (holder === owner) return "claimed";
	if (Number.isInteger(holder) && holder > 0) {
		if (isAlive(holder)) return "held";
	} else if (ageMs < CLAIM_WRITE_GRACE_MS) {
		return "held";
	}
	rmSync(file, { force: true });
	return "retry";
}

// Exclusive owner file. An empty file is a claim still being written.
export function claim(file: string, owner = process.pid): boolean {
	mkdirSync(path.dirname(file), { recursive: true });
	for (let attempt = 0; attempt < CLAIM_ATTEMPTS_MAX; attempt += 1) {
		const result = claimOnce(file, owner);
		if (result === "claimed") return true;
		if (result === "held") return false;
	}
	throw new Error(
		`Could not claim ${file} after ${CLAIM_ATTEMPTS_MAX} attempts; another process keeps replacing it.`
	);
}

export function release(file: string, owner = process.pid): void {
	try {
		if (Number(readFileSync(file, "utf8")) === owner) rmSync(file);
	} catch (error: unknown) {
		// Already released.
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

// Serializes steps that touch checkout-wide files: Astro writes .astro/ and
// .wrangler/deploy/config.json, which `astro preview` reads at startup.
export async function withCheckoutLock<Result>(
	root: string,
	task: () => Promise<Result> | Result
): Promise<Result> {
	const file = path.join(root, ".wrangler", "e2e", "checkout.lock");
	if (!claim(file)) {
		process.stderr.write(
			`Waiting for another browser test build in this checkout (${path.relative(root, file)}).\n`
		);
		const deadlineMs = Date.now() + CHECKOUT_LOCK_WAIT_MS_MAX;
		while (!claim(file)) {
			if (Date.now() >= deadlineMs)
				throw new Error(
					`${file} is still held after ${CHECKOUT_LOCK_WAIT_MS_MAX / 60_000} minutes (pid ${readFileSync(file, "utf8")}). Stop that process by PID.`
				);
			await delay(CHECKOUT_LOCK_POLL_INTERVAL_MS);
		}
	}
	try {
		return await task();
	} finally {
		release(file);
	}
}

// Machine-wide registry so concurrent runs in different checkouts do not pick
// the same port while one of them is still building.
export const portRegistry = path.join(tmpdir(), "stack-e2e-ports");

export type PortSearch = {
	readonly registry?: string;
	readonly first?: number;
	readonly candidatesCount?: number;
};

async function claimRequestedPort(
	requested: string,
	registry: string
): Promise<number> {
	const port = parsePort(requested);
	const file = path.join(registry, `${port}.pid`);
	if (!claim(file))
		throw new Error(
			`STACK_E2E_PORT=${port} is in use by another browser test run (pid ${readFileSync(file, "utf8")}). Unset STACK_E2E_PORT to pick a free port.`
		);
	if (await portAvailable(port)) return port;
	release(file);
	const owner = describePortOwner(port);
	throw new Error(
		`STACK_E2E_PORT=${port} is already in use${owner === null ? "" : ` by ${owner}`}. Stop that server (\`pnpm dev:stop\` for this checkout's dev server) or unset STACK_E2E_PORT to pick a free port.`
	);
}

export async function claimE2EPort(
	requested: string | undefined,
	search: PortSearch = {}
): Promise<number> {
	const {
		registry = portRegistry,
		first = defaultE2EPort,
		candidatesCount = E2E_PORT_CANDIDATES_COUNT,
	} = search;
	if (requested !== undefined && requested !== "")
		return claimRequestedPort(requested, registry);
	for (let port = first; port < first + candidatesCount; port += 1) {
		const file = path.join(registry, `${port}.pid`);
		if (!claim(file)) continue;
		if (await portAvailable(port)) return port;
		release(file);
	}
	throw new Error(
		`No free browser test port in ${first}-${first + candidatesCount - 1}.`
	);
}

export function releaseE2EPort(port: number, registry = portRegistry): void {
	release(path.join(registry, `${port}.pid`));
}
