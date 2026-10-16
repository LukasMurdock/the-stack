// `pnpm admin:bootstrap` gives a deployment its first administrator without
// email: it calls POST /api/internal/bootstrap-admin with BOOTSTRAP_SECRET and
// prints the generated password once. Nothing is written to disk; the Worker
// keeps only the hash and refuses a second bootstrap for the same address.

import { deploymentCloudflare } from "../config/cloudflare.mjs";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import { productionOrigin } from "./lib/release.ts";
import { z } from "zod";

// A cold Worker, the compromised-password lookup and scrypt fit well inside.
export const BOOTSTRAP_REQUEST_TIMEOUT_MS = 30_000;
// The JSON reply is under 300 bytes; anything far larger is not the bootstrap
// endpoint (a proxy or login page) and is not echoed.
export const BOOTSTRAP_RESPONSE_BYTES_MAX = 16_384;
const DELIVERIES = ["response", "email"] as const;
type Delivery = (typeof DELIVERIES)[number];
// Plain HTTP would carry the secret and the password in the clear; only a
// server on this machine may use it.
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

export const ADMIN_BOOTSTRAP_USAGE = `Usage: BOOTSTRAP_SECRET=... pnpm admin:bootstrap [--url <origin>] [--delivery response|email]

Creates ADMIN_EMAIL's administrator account on a deployment that has not been
bootstrapped, and prints its password once. Nothing is saved.

  --url <origin>       Deployment origin (default: APP_URL in config/cloudflare.mjs).
                       Must be https, except localhost.
  --delivery <mode>    response (default): print a generated password here.
                       email: email ADMIN_EMAIL a reset link instead.
  -h, --help           Show this help.

Read the secret without echoing it: read -rs BOOTSTRAP_SECRET && export BOOTSTRAP_SECRET`;

export type AdminBootstrapOptions = {
	readonly origin: string;
	readonly delivery: Delivery;
	readonly secret: string;
};

export function parseAdminBootstrapOptions(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
	defaultAppUrl: string
): Command<AdminBootstrapOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		url: { type: "string" },
		delivery: { type: "string" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length > 0)
		throw new UsageError(`Unexpected argument: ${positionals.join(" ")}.`);
	const delivery = DELIVERIES.find(
		(mode) => mode === (values.delivery ?? "response")
	);
	if (delivery === undefined)
		throw new UsageError(
			`--delivery must be response or email, got "${values.delivery}".`
		);
	const origin =
		values.url === undefined
			? productionOrigin(defaultAppUrl)
			: parseOrigin(values.url);
	const secret = env.BOOTSTRAP_SECRET ?? "";
	if (secret.trim().length === 0)
		throw new UsageError(
			"Set BOOTSTRAP_SECRET to the value stored with `pnpm exec void secret put BOOTSTRAP_SECRET`."
		);
	return { kind: "run", options: { origin, delivery, secret } };
}

function parseOrigin(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch (error: unknown) {
		throw new UsageError(
			`--url must be an origin such as https://app.example.com, got "${value}".`,
			{ cause: error }
		);
	}
	if (url.protocol === "https:") return url.origin;
	if (url.protocol === "http:" && LOOPBACK_HOSTS.includes(url.hostname))
		return url.origin;
	throw new UsageError(
		`--url must use https (http is allowed only for localhost), got "${value}".`
	);
}

const replySchema = z.object({
	ok: z.boolean(),
	status: z.string(),
	credential: z
		.object({ email: z.string(), password: z.string() })
		.optional(),
});

export type BootstrapIo = {
	fetch(url: string, init: RequestInit): Promise<Response>;
	log(line: string): void;
};

export async function adminBootstrap(
	io: BootstrapIo,
	options: AdminBootstrapOptions
): Promise<void> {
	const url = `${options.origin}/api/internal/bootstrap-admin`;
	const response = await post(io, url, options);
	if (response.status !== 200) {
		await response.body?.cancel();
		throw new CommandError(failureMessage(response.status, url));
	}
	const text = await readBounded(response, url);
	const reply = parseReply(text, url);
	if (options.delivery === "email") {
		io.log(
			"Bootstrapped. ADMIN_EMAIL has been sent a link to set the password."
		);
		return;
	}
	if (reply.credential === undefined)
		throw new CommandError(
			`${url} did not return a credential; is the deployment up to date?`
		);
	io.log(`Admin:    ${reply.credential.email}`);
	io.log(`Password: ${reply.credential.password}`);
	io.log(
		"          Shown once and not saved anywhere. Store it in a password manager now."
	);
	io.log(`Sign in:  ${options.origin}/app/login`);
	io.log("Then remove the secret so it cannot be used again:");
	io.log("          pnpm exec void secret delete BOOTSTRAP_SECRET");
}

async function post(
	io: BootstrapIo,
	url: string,
	options: AdminBootstrapOptions
): Promise<Response> {
	try {
		return await io.fetch(url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-bootstrap-secret": options.secret,
			},
			body: JSON.stringify({ delivery: options.delivery }),
			redirect: "error",
			signal: AbortSignal.timeout(BOOTSTRAP_REQUEST_TIMEOUT_MS),
		});
	} catch (error: unknown) {
		if (error instanceof Error && error.name === "TimeoutError")
			throw new CommandError(
				`${url} did not answer within ${BOOTSTRAP_REQUEST_TIMEOUT_MS / 1_000} s.`,
				{ cause: error }
			);
		const reason = error instanceof Error ? error.message : String(error);
		throw new CommandError(`Could not reach ${url}: ${reason}`, {
			cause: error,
		});
	}
}

async function readBounded(response: Response, url: string): Promise<string> {
	const reader = response.body?.getReader();
	if (reader === undefined) return "";
	const chunks: Uint8Array[] = [];
	let sizeBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		sizeBytes += value.byteLength;
		if (sizeBytes > BOOTSTRAP_RESPONSE_BYTES_MAX) {
			await reader.cancel();
			throw new CommandError(
				`${url} returned more than ${BOOTSTRAP_RESPONSE_BYTES_MAX} bytes; is this the app's origin?`
			);
		}
		chunks.push(value);
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

function parseReply(text: string, url: string): z.infer<typeof replySchema> {
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch (error: unknown) {
		throw new CommandError(
			`${url} did not return JSON; is this the app's origin?`,
			{ cause: error }
		);
	}
	const reply = replySchema.safeParse(json);
	if (!reply.success)
		throw new CommandError(`${url} returned an unexpected reply.`);
	return reply.data;
}

function failureMessage(status: number, url: string): string {
	switch (status) {
		case 401:
			return "The deployment rejected BOOTSTRAP_SECRET (or has none set). Check `pnpm exec void secret list`.";
		case 409:
			return [
				"This deployment is already bootstrapped for ADMIN_EMAIL; no new password was made.",
				"Sign in, or use Forgot password once email works. To force a new password, someone",
				"with Cloudflare access deletes the KV key bootstrap:admin:<admin email> in CORE_KV",
				"and reruns this command; it replaces the password and ends existing sessions.",
			].join("\n");
		case 503:
			return "The deployment cannot send email. Rerun without --delivery email to get a password here.";
		case 404:
			return `${url} was not found; deploy this version first.`;
		default:
			return `${url} returned HTTP ${status}.`;
	}
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: ADMIN_BOOTSTRAP_USAGE,
		parse: () =>
			parseAdminBootstrapOptions(
				process.argv.slice(2),
				process.env,
				deploymentCloudflare.vars.APP_URL
			),
		run: (options) =>
			adminBootstrap(
				{
					fetch: (url, init) => fetch(url, init),
					log: (line) => process.stdout.write(`${line}\n`),
				},
				options
			),
	});
