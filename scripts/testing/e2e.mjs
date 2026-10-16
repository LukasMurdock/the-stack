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
import {
	describePortOwner,
	isAlive,
	portAvailable,
} from "../lib/local-server.mjs";

export const defaultE2EPort = 4322;

// Everything a browser run writes is keyed by port, so parallel runs in one
// checkout never share D1 state, Worker config or build output.
export function e2ePaths(port, root = process.cwd()) {
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

export function parsePort(value) {
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1024 || port > 65535)
		throw new Error(
			"STACK_E2E_PORT must be an integer between 1024 and 65535"
		);
	return port;
}

// Files that cannot change the Worker or client bundle. Everything else
// tracked or untracked-but-not-ignored invalidates the E2E build.
const nonBuildInputs =
	/^(?:tests|docs|tools|\.github|\.husky|\.agents|\.vscode)\/|^[^/]+\.md$|^(?:LICENSE|justfile)$/;

// Content hash of the build inputs. Returns null outside a Git checkout, which
// callers treat as "always rebuild".
export function buildFingerprint(root = process.cwd(), extra = "") {
	let files;
	try {
		files = execFileSync(
			"git",
			["ls-files", "-z", "-c", "-o", "--exclude-standard"],
			{ cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		)
			.split("\0")
			.filter((file) => file && !nonBuildInputs.test(file));
	} catch {
		return null;
	}
	const hash = createHash("sha256").update(extra);
	for (const file of [...new Set(files)].sort()) {
		hash.update(`\0${file}\0`);
		try {
			hash.update(readFileSync(path.join(root, file)));
		} catch {
			hash.update("\0deleted");
		}
	}
	return hash.digest("hex");
}

// Stamps are written after their artifact is complete and record the
// fingerprint of the inputs it was produced from.
export function stampMatches(file, fingerprint) {
	if (!fingerprint || process.env.STACK_E2E_REBUILD === "1") return false;
	try {
		return (
			JSON.parse(readFileSync(file, "utf8")).fingerprint === fingerprint
		);
	} catch {
		return false;
	}
}

// Exclusive owner file. An empty file is a claim still being written.
export function claim(file, owner = process.pid) {
	mkdirSync(path.dirname(file), { recursive: true });
	try {
		writeFileSync(file, String(owner), { flag: "wx" });
		return true;
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
	}
	let holder;
	try {
		holder = Number(readFileSync(file, "utf8")) || null;
		if (!holder && Date.now() - statSync(file).mtimeMs < 5_000)
			return false;
	} catch {
		return claim(file, owner);
	}
	if (holder === owner) return true;
	if (holder && isAlive(holder)) return false;
	rmSync(file, { force: true });
	return claim(file, owner);
}

export function release(file, owner = process.pid) {
	try {
		if (Number(readFileSync(file, "utf8")) === owner) rmSync(file);
	} catch {
		// Already released.
	}
}

// Serializes steps that touch checkout-wide files: Astro writes .astro/ and
// .wrangler/deploy/config.json, which `astro preview` reads at startup.
export async function withCheckoutLock(root, task) {
	const file = path.join(root, ".wrangler", "e2e", "checkout.lock");
	if (!claim(file)) {
		process.stderr.write(
			`Waiting for another browser test build in this checkout (${path.relative(root, file)}).\n`
		);
		while (!claim(file)) await delay(250);
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

export async function claimE2EPort(
	requested,
	{ registry = portRegistry, first = defaultE2EPort, attempts = 100 } = {}
) {
	const candidates = requested
		? [parsePort(requested)]
		: Array.from({ length: attempts }, (_, index) => first + index);
	for (const port of candidates) {
		const file = path.join(registry, `${port}.pid`);
		if (!claim(file)) {
			if (requested)
				throw new Error(
					`STACK_E2E_PORT=${port} is in use by another browser test run (pid ${readFileSync(file, "utf8")}). Unset STACK_E2E_PORT to pick a free port.`
				);
			continue;
		}
		if (await portAvailable(port)) return port;
		release(file);
		if (requested) {
			const owner = describePortOwner(port);
			throw new Error(
				`STACK_E2E_PORT=${port} is already in use${owner ? ` by ${owner}` : ""}. Stop that server (\`pnpm dev:stop\` for this checkout's dev server) or unset STACK_E2E_PORT to pick a free port.`
			);
		}
	}
	throw new Error(
		`No free browser test port in ${first}-${first + attempts - 1}.`
	);
}

export function releaseE2EPort(port, registry = portRegistry) {
	release(path.join(registry, `${port}.pid`));
}
