// What `pnpm shot` and `pnpm api` share: which server to talk to, who to sign
// in as, and how a path typed on the command line becomes a URL on that server.

import { readFileSync } from "node:fs";
import path from "node:path";
import { appBasepath } from "../../src/react-app/mount.ts";
import {
	type FixturePersona,
	FIXTURE_PASSWORD,
	FIXTURE_PERSONAS,
	fixtureEmail,
	isFixturePersona,
} from "../testing/personas.ts";
import { CommandError, errorCode, UsageError } from "./cli.ts";
import { readDevServer } from "./local-server.ts";
import { startE2EServer } from "../testing/e2e-server.ts";

export const API_BASE_PATH = "/api";
export const PAGE_BASE_PATH = appBasepath;
// Longer than any route this app has; a longer argument is a pasted mistake.
const APP_PATH_CHARACTERS_MAX = 2_048;
const SIGN_IN_TIMEOUT_MS = 30_000;
// Enough of a failed sign-in body to show Better Auth's error code.
const SIGN_IN_ERROR_EXCERPT_CHARACTERS_MAX = 300;
// Credentials are a few hundred bytes; anything larger is not that file.
const ADMIN_PASSWORD_FILE_BYTES_MAX = 4_096;

export const ADMIN_PASSWORD_FILE = path.join(".wrangler", ".admin-password");

// The --as help text, indented to line up under a usage column.
export function asUsage(indent: string): string {
	return `--as${indent.slice(4)}admin (default), owner, viewer, an email, or anonymous.
  ${indent}On the dev server "admin" is the local admin in
  ${indent}${ADMIN_PASSWORD_FILE}; fixture users need --e2e.`;
}

export type Identity =
	| { readonly kind: "anonymous" }
	| { readonly kind: "persona"; readonly persona: FixturePersona }
	| { readonly kind: "email"; readonly email: string };

export type ServerKind = "dev" | "e2e";

export type Credentials = {
	readonly email: string;
	readonly password: string;
};

// The signed-in session as cookie name/value pairs, ready for a Cookie header
// or a browser context.
export type Session = {
	readonly cookies: readonly {
		readonly name: string;
		readonly value: string;
	}[];
};

// `--as` -> an identity. Which password it maps to depends on the server.
export function parseIdentity(value: string | undefined): Identity {
	if (value === undefined) return { kind: "persona", persona: "admin" };
	const trimmed = value.trim().toLowerCase();
	if (trimmed === "anonymous") return { kind: "anonymous" };
	if (isFixturePersona(trimmed)) return { kind: "persona", persona: trimmed };
	if (/^[^\s@]+@[^\s@]+$/.test(trimmed))
		return { kind: "email", email: trimmed };
	throw new UsageError(
		`--as must be ${FIXTURE_PERSONAS.join(", ")}, an email, or anonymous; got "${value}".`
	);
}

// A command-line path -> a path on the server. Without a leading slash it is
// relative to `base` (/app for pages, /api for requests), so an agent never
// has to guess the SPA's mount point; with one it is taken as written.
export function resolveAppPath(input: string, base: string): string {
	if (input.length === 0) throw new UsageError("A path cannot be empty.");
	if (input.length > APP_PATH_CHARACTERS_MAX)
		throw new UsageError(
			`A path must be at most ${APP_PATH_CHARACTERS_MAX} characters.`
		);
	if (/\s/.test(input) || hasControlCharacter(input))
		throw new UsageError(
			`A path cannot contain whitespace or control characters: ${JSON.stringify(input)}.`
		);
	if (input.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(input))
		throw new UsageError(
			`Give a path on the local server, not a URL: "${input}".`
		);
	const joined = input.startsWith("/") ? input : `${base}/${input}`;
	const placeholderOrigin = "http://local.invalid";
	const url = new URL(joined, placeholderOrigin);
	if (url.origin !== placeholderOrigin)
		throw new UsageError(`Path leaves the local server: "${input}".`);
	return `${url.pathname}${url.search}${url.hash}`;
}

// The running dev server for this checkout, or a CommandError that says how
// to start one.
export async function devServerOrigin(root: string): Promise<string> {
	const server = readDevServer(root);
	if (server === null || !server.alive)
		throw new CommandError(
			"No dev server is running for this checkout.\nStart one with `pnpm dev --background` and `pnpm dev:wait`, or add --e2e for an isolated server with seeded fixture users."
		);
	return server.url;
}

// Runs `task` against the chosen server: the checkout's dev server as it is,
// or a fresh isolated one that is stopped afterwards.
export async function withServer<Result>(
	kind: ServerKind,
	root: string,
	task: (origin: string) => Promise<Result>
): Promise<Result> {
	if (kind === "dev") return task(await devServerOrigin(root));
	const server = await startE2EServer(root);
	try {
		return await task(server.origin);
	} finally {
		await server.stop();
	}
}

export function credentialsFor(
	identity: Identity,
	server: ServerKind,
	root: string
): Credentials | null {
	switch (identity.kind) {
		case "anonymous":
			return null;
		case "persona":
			return personaCredentials(identity.persona, server, root);
		case "email":
			return emailCredentials(identity.email, server, root);
		default:
			return assertNever(identity);
	}
}

function personaCredentials(
	persona: FixturePersona,
	server: ServerKind,
	root: string
): Credentials {
	if (server === "e2e")
		return { email: fixtureEmail(persona), password: FIXTURE_PASSWORD };
	if (persona === "admin") return readAdminCredentials(root);
	throw new CommandError(
		`The ${persona} fixture user exists only in isolated browser-test state; add --e2e.`
	);
}

function emailCredentials(
	email: string,
	server: ServerKind,
	root: string
): Credentials {
	if (server === "e2e") {
		const persona = FIXTURE_PERSONAS.find(
			(candidate) => fixtureEmail(candidate) === email
		);
		if (persona === undefined)
			throw new CommandError(
				`${email} is not a fixture user. Use ${FIXTURE_PERSONAS.map(fixtureEmail).join(", ")}.`
			);
		return { email, password: FIXTURE_PASSWORD };
	}
	const admin = readAdminCredentials(root);
	if (admin.email.toLowerCase() !== email)
		throw new CommandError(
			`Only the local admin's password is known (${admin.email}, in ${ADMIN_PASSWORD_FILE}). Use --as admin, or --e2e for fixture users.`
		);
	return admin;
}

// create-admin-local writes { email, password, createdAt } with mode 0600.
export function readAdminCredentials(root: string): Credentials {
	const file = path.join(root, ADMIN_PASSWORD_FILE);
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error: unknown) {
		if (errorCode(error) === "ENOENT")
			throw new CommandError(
				`No local admin credentials in ${ADMIN_PASSWORD_FILE}. Run \`pnpm local:setup\`.`
			);
		throw error;
	}
	if (Buffer.byteLength(text) > ADMIN_PASSWORD_FILE_BYTES_MAX)
		throw new CommandError(
			`${ADMIN_PASSWORD_FILE} is not a credential file.`
		);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new CommandError(`${ADMIN_PASSWORD_FILE} is not valid JSON.`);
	}
	if (typeof parsed !== "object" || parsed === null)
		throw new CommandError(`${ADMIN_PASSWORD_FILE} is not a JSON object.`);
	const email = "email" in parsed ? parsed.email : undefined;
	const password = "password" in parsed ? parsed.password : undefined;
	if (typeof email !== "string" || typeof password !== "string")
		throw new CommandError(
			`${ADMIN_PASSWORD_FILE} needs string "email" and "password" fields.`
		);
	return { email, password };
}

// Signs in through Better Auth's email endpoint, exactly as the login form
// does, and returns the session cookies it sets.
export async function signIn(
	origin: string,
	credentials: Credentials
): Promise<Session> {
	const response = await fetch(`${origin}/api/auth/sign-in/email`, {
		method: "POST",
		headers: { "content-type": "application/json", origin },
		body: JSON.stringify(credentials),
		redirect: "manual",
		signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
	});
	if (!response.ok) {
		const body = await response.text();
		throw new CommandError(
			`Sign-in as ${credentials.email} failed: HTTP ${response.status} ${body.slice(0, SIGN_IN_ERROR_EXCERPT_CHARACTERS_MAX)}`
		);
	}
	await response.body?.cancel();
	const cookies = parseSetCookies(response.headers.getSetCookie());
	if (cookies.length === 0)
		throw new CommandError(
			`Sign-in as ${credentials.email} answered HTTP ${response.status} without a session cookie.`
		);
	return { cookies };
}

export function parseSetCookies(
	headers: readonly string[]
): Session["cookies"] {
	const cookies: { name: string; value: string }[] = [];
	for (const header of headers) {
		const pair = header.split(";", 1)[0] ?? "";
		const separatorIndex = pair.indexOf("=");
		if (separatorIndex <= 0) continue;
		cookies.push({
			name: pair.slice(0, separatorIndex).trim(),
			value: pair.slice(separatorIndex + 1).trim(),
		});
	}
	return cookies;
}

export function cookieHeader(session: Session): string {
	return session.cookies
		.map((cookie) => `${cookie.name}=${cookie.value}`)
		.join("; ");
}

function hasControlCharacter(text: string): boolean {
	for (let index = 0; index < text.length; index += 1)
		if (text.charCodeAt(index) < 0x20) return true;
	return false;
}

function assertNever(value: never): never {
	throw new Error(`Unexpected value: ${String(value)}`);
}
