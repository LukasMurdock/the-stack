import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { API_RESPONSE_BYTES_MAX } from "../../scripts/api.ts";

// `pnpm shot` and `pnpm api` run as subprocesses, exactly as pnpm starts
// them, from a scratch checkout whose .astro/dev.json points at a stand-in
// server. The stand-in implements just the Better Auth sign-in and a few
// pages and endpoints, so these tests cover argv parsing, credential
// lookup, sign-in, cookies, path resolution and reporting end to end.

const SESSION_COOKIE = "better-auth.session_token=signed-in-token";
const ADMIN = { email: "admin@example.test", password: "local-admin-pass" };
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

type Seen = { pageCookies: Record<string, boolean> };

function signedIn(request: IncomingMessage): boolean {
	return (request.headers.cookie ?? "").includes(SESSION_COOKIE);
}

async function readBody(request: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

function html(response: ServerResponse, body: string, status = 200) {
	response.writeHead(status, { "content-type": "text/html" });
	response.end(`<!doctype html><html><body>${body}</body></html>`);
}

function json(response: ServerResponse, status: number, value: unknown) {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(value));
}

async function handle(
	request: IncomingMessage,
	response: ServerResponse,
	seen: Seen
) {
	const url = new URL(request.url ?? "/", "http://stand-in");
	const route = `${request.method} ${url.pathname}`;
	if (url.pathname.startsWith("/app/"))
		seen.pageCookies[url.pathname] = signedIn(request);
	switch (route) {
		case "POST /api/auth/sign-in/email": {
			const body: unknown = JSON.parse(await readBody(request));
			const ok = JSON.stringify(body) === JSON.stringify(ADMIN);
			if (!ok)
				return json(response, 401, {
					code: "INVALID_EMAIL_OR_PASSWORD",
				});
			response.setHeader(
				"set-cookie",
				`${SESSION_COOKIE}; Path=/; HttpOnly`
			);
			return json(response, 200, { user: { email: ADMIN.email } });
		}
		case "GET /api/organizations":
			if (!signedIn(request)) return json(response, 401, { error: "no" });
			return json(response, 200, { organizations: [{ name: "Studio" }] });
		case "POST /api/echo":
			return json(response, 201, JSON.parse(await readBody(request)));
		case "GET /api/large":
			response.writeHead(200, { "content-type": "application/json" });
			return response.end("x".repeat(API_RESPONSE_BYTES_MAX + 10));
		case "GET /app/clean":
			return html(response, "<h1>Clean</h1>");
		case "GET /app/broken":
			return html(
				response,
				`<h1>Broken</h1><script>console.error("boom"); fetch("/api/missing");</script>`
			);
		case "GET /app/throws":
			return html(
				response,
				`<h1>Throws</h1><script>throw new Error("kaboom");</script>`
			);
		default:
			return html(response, "Not found", 404);
	}
}

async function standIn(t: test.TestContext) {
	const seen: Seen = { pageCookies: {} };
	const server: Server = createServer((request, response) => {
		handle(request, response, seen).catch((error: unknown) => {
			response.writeHead(500);
			response.end(String(error));
		});
	});
	await new Promise<void>((resolve) =>
		server.listen(0, "127.0.0.1", resolve)
	);
	t.after(() => server.close());
	const address = server.address();
	if (address === null || typeof address === "string")
		throw new Error("Expected a TCP address.");
	const checkout = mkdtempSync(path.join(tmpdir(), "stack-agent-eyes-"));
	t.after(() => rmSync(checkout, { recursive: true, force: true }));
	mkdirSync(path.join(checkout, ".astro"));
	mkdirSync(path.join(checkout, ".wrangler"));
	// This test process stands in for the dev server's PID, so it is alive.
	writeFileSync(
		path.join(checkout, ".astro", "dev.json"),
		JSON.stringify({
			pid: process.pid,
			url: `http://127.0.0.1:${address.port}/`,
		})
	);
	writeFileSync(
		path.join(checkout, ".wrangler", ".admin-password"),
		JSON.stringify({ ...ADMIN, createdAt: new Date(0).toISOString() })
	);
	return { checkout, seen };
}

// Asynchronous: the stand-in server runs in this process and must keep
// answering while the CLI runs.
function run(script: string, args: readonly string[], cwd: string) {
	const child = spawn(
		process.execPath,
		[path.resolve("scripts", script), ...args],
		{ cwd, stdio: ["ignore", "pipe", "pipe"] }
	);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	return new Promise<{
		status: number | null;
		stdout: string;
		stderr: string;
	}>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (status) => resolve({ status, stdout, stderr }));
	});
}

test("pnpm api signs in as the local admin and prints the JSON answer", async (t) => {
	const { checkout } = await standIn(t);
	const ok = await run("api.ts", ["GET", "organizations"], checkout);
	assert.equal(ok.status, 0, ok.stderr);
	assert.match(ok.stderr, /^HTTP 200 OK {2}GET \/api\/organizations/m);
	assert.deepEqual(JSON.parse(ok.stdout), {
		organizations: [{ name: "Studio" }],
	});
	assert.match(ok.stdout, /\n {2}"organizations"/);

	const anonymous = await run(
		"api.ts",
		["GET", "/api/organizations", "--as", "anonymous"],
		checkout
	);
	assert.equal(anonymous.status, 1);
	assert.match(anonymous.stderr, /answered HTTP 401/);

	const echo = await run("api.ts", ["post", "echo", '{"a":[1,2]}'], checkout);
	assert.equal(echo.status, 0, echo.stderr);
	assert.deepEqual(JSON.parse(echo.stdout), { a: [1, 2] });

	const large = await run("api.ts", ["GET", "large"], checkout);
	assert.equal(large.status, 0, large.stderr);
	assert.equal(large.stdout.length, API_RESPONSE_BYTES_MAX + 1);
	assert.match(large.stderr, /truncated at 1048576 bytes/);
});

test("pnpm api rejects bad arguments and unknown identities before any request", async (t) => {
	const { checkout } = await standIn(t);
	for (const [args, message] of [
		[["FETCH", "organizations"], /<METHOD> must be one of/],
		[["POST", "echo", "{not json"], /not valid JSON/],
		[["GET", "http://example.com/api"], /not a URL/],
		[["GET"], /Give a method and a path/],
		[["GET", "x", "--as", "nobody"], /--as must be/],
	] as const) {
		const result = await run("api.ts", args, checkout);
		assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
		assert.match(result.stderr, message);
		assert.match(result.stderr, /Usage: pnpm api/);
	}
	const persona = await run(
		"api.ts",
		["GET", "x", "--as", "viewer"],
		checkout
	);
	assert.equal(persona.status, 1);
	assert.match(
		persona.stderr,
		/exists only in isolated browser-test state; add --e2e/
	);
	const stranger = await run(
		"api.ts",
		["GET", "x", "--as", "someone@example.test"],
		checkout
	);
	assert.equal(stranger.status, 1);
	assert.match(stranger.stderr, /Only the local admin's password is known/);
});

test("pnpm shot writes signed-in PNGs and warns about console errors and failed requests", async (t) => {
	const { checkout, seen } = await standIn(t);
	const out = path.join(checkout, "shots");
	const result = await run(
		"shot.ts",
		[
			"clean",
			"/app/broken",
			"--viewport",
			"phone",
			"--viewport",
			"640x480",
			"--out",
			out,
		],
		checkout
	);
	assert.equal(result.status, 0, result.stderr);
	for (const file of [
		"app-clean.phone.png",
		"app-clean.640x480.png",
		"app-broken.phone.png",
		"app-broken.640x480.png",
	]) {
		const png = readFileSync(path.join(out, file));
		assert.deepEqual(png.subarray(0, 4), PNG_SIGNATURE, file);
	}
	assert.match(
		result.stdout,
		/^200 \/app\/clean {2}-> {2}.*app-clean\.phone\.png \(\d+ KB\)$/m
	);
	assert.match(result.stdout, /warning: console error: boom/);
	assert.match(result.stdout, /warning: HTTP 404 GET \/api\/missing/);
	// Chromium's own "Failed to load resource" line duplicates the request.
	assert.doesNotMatch(result.stdout, /Failed to load resource/);
	assert.match(result.stdout, /2 of 4 pages logged console errors/);
	assert.deepEqual(seen.pageCookies, {
		"/app/clean": true,
		"/app/broken": true,
	});
});

test("pnpm shot fails for pages that did not load or threw, and points stray paths at /app", async (t) => {
	const { checkout, seen } = await standIn(t);
	const out = path.join(checkout, "shots");
	const result = await run(
		"shot.ts",
		["/tickets", "throws", "--as", "anonymous", "--out", out],
		checkout
	);
	assert.equal(result.status, 1, result.stderr);
	assert.match(
		result.stdout,
		/error: page answered HTTP 404 \(app pages are under \/app/
	);
	assert.match(result.stdout, /error: uncaught: kaboom/);
	assert.match(result.stderr, /2 of 2 pages did not load or threw/);
	assert.ok(existsSync(path.join(out, "tickets.desktop.png")));
	assert.ok(existsSync(path.join(out, "app-throws.desktop.png")));
	assert.deepEqual(seen.pageCookies, { "/app/throws": false });
});

test("pnpm shot and pnpm api explain how to start a server when none is running", async (t) => {
	const empty = mkdtempSync(path.join(tmpdir(), "stack-agent-eyes-empty-"));
	t.after(() => rmSync(empty, { recursive: true, force: true }));
	for (const [script, args] of [
		["shot.ts", ["organizations"]],
		["api.ts", ["GET", "organizations"]],
	] as const) {
		const result = await run(script, args, empty);
		assert.equal(result.status, 1, result.stderr);
		assert.match(
			result.stderr,
			/No dev server is running for this checkout/
		);
		assert.match(result.stderr, /--e2e/);
		assert.doesNotMatch(result.stderr, /\n\s+at /);
	}
});
