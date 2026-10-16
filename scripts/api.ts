// `pnpm api <METHOD> <path> [json]`: one authenticated request against the
// local server, printing the status and the JSON answer, so an agent can
// check an endpoint without a hand-written sign-in and cookie-jar script.

import {
	type Command,
	CommandError,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	API_BASE_PATH,
	asUsage,
	cookieHeader,
	credentialsFor,
	type Identity,
	parseIdentity,
	resolveAppPath,
	type ServerKind,
	signIn,
	withServer,
} from "./lib/local-app.ts";

export const API_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiMethod = (typeof API_METHODS)[number];
// Larger than any form this app submits; a bigger body belongs in a test.
export const API_REQUEST_BYTES_MAX = 64 * 1_024;
// Printed in full up to this size, then truncated with a note.
export const API_RESPONSE_BYTES_MAX = 1_024 * 1_024;
const API_REQUEST_TIMEOUT_MS = 30_000;

export const API_USAGE = `Usage: pnpm api <METHOD> <path> [json] [--as <who>] [--e2e]

Sends one request to the local server, signed in, and prints the status on
stderr and the response (pretty-printed JSON) on stdout. Exits 1 unless the
status is 2xx.

  <METHOD>  ${API_METHODS.join(", ")}.
  <path>    Relative paths are under ${API_BASE_PATH} ("organizations" is ${API_BASE_PATH}/organizations);
            a leading slash is taken as written.
  [json]    Request body, at most ${API_REQUEST_BYTES_MAX / 1_024} KiB of valid JSON.
  ${asUsage("          ")}
  --e2e     Start an isolated server with seeded fixture users instead of
            using this checkout's running dev server (pnpm dev).`;

export type ApiOptions = {
	readonly method: ApiMethod;
	readonly path: string;
	readonly body: string | null;
	readonly identity: Identity;
	readonly server: ServerKind;
};

export function parseApiOptions(argv: readonly string[]): Command<ApiOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		as: { type: "string" },
		e2e: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	const [methodText, pathText, bodyText, ...extra] = positionals;
	if (methodText === undefined || pathText === undefined)
		throw new UsageError("Give a method and a path.");
	if (extra.length > 0)
		throw new UsageError(`Unexpected argument: ${extra.join(" ")}.`);
	return {
		kind: "run",
		options: {
			method: parseMethod(methodText),
			path: resolveAppPath(pathText, API_BASE_PATH),
			body: bodyText === undefined ? null : parseBody(bodyText),
			identity: parseIdentity(values.as),
			server: values.e2e === true ? "e2e" : "dev",
		},
	};
}

function parseMethod(value: string): ApiMethod {
	const upper = value.toUpperCase();
	const method = API_METHODS.find((candidate) => candidate === upper);
	if (method === undefined)
		throw new UsageError(
			`<METHOD> must be one of ${API_METHODS.join(", ")}, got "${value}".`
		);
	return method;
}

// Validated here so a typo fails before signing in, and sent as typed.
function parseBody(value: string): string {
	if (Buffer.byteLength(value) > API_REQUEST_BYTES_MAX)
		throw new UsageError(
			`The JSON body must be at most ${API_REQUEST_BYTES_MAX} bytes.`
		);
	try {
		JSON.parse(value);
	} catch (error: unknown) {
		if (!(error instanceof SyntaxError)) throw error;
		throw new UsageError(`The body is not valid JSON: ${error.message}`);
	}
	return value;
}

export async function callApi(options: ApiOptions): Promise<void> {
	const root = process.cwd();
	await withServer(options.server, root, async (origin) => {
		const credentials = credentialsFor(
			options.identity,
			options.server,
			root
		);
		const session =
			credentials === null ? null : await signIn(origin, credentials);
		const headers: Record<string, string> = {
			origin,
			accept: "application/json",
		};
		if (session !== null) headers.cookie = cookieHeader(session);
		if (options.body !== null) headers["content-type"] = "application/json";
		const response = await fetch(`${origin}${options.path}`, {
			method: options.method,
			headers,
			body: options.body,
			redirect: "manual",
			signal: AbortSignal.timeout(API_REQUEST_TIMEOUT_MS),
		});
		const body = await readBounded(response, API_RESPONSE_BYTES_MAX);
		const status = `HTTP ${response.status} ${response.statusText}`.trim();
		if (response.ok)
			process.stderr.write(
				`${status}  ${options.method} ${options.path}\n`
			);
		process.stdout.write(`${formatBody(response, body)}\n`);
		if (body.truncated)
			process.stderr.write(
				`(response truncated at ${API_RESPONSE_BYTES_MAX} bytes)\n`
			);
		if (!response.ok)
			throw new CommandError(
				`${options.method} ${options.path} answered ${status}.`
			);
	});
}

type BoundedBody = { readonly text: string; readonly truncated: boolean };

// Reads at most `bytesMax` bytes and cancels the rest of the stream.
export async function readBounded(
	response: Response,
	bytesMax: number
): Promise<BoundedBody> {
	if (response.body === null) return { text: "", truncated: false };
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let sizeBytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		const remainingBytes = bytesMax - sizeBytes;
		if (value.byteLength > remainingBytes) {
			chunks.push(value.subarray(0, remainingBytes));
			await reader.cancel();
			return {
				text: Buffer.concat(chunks).toString("utf8"),
				truncated: true,
			};
		}
		chunks.push(value);
		sizeBytes += value.byteLength;
	}
	return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

function formatBody(response: Response, body: BoundedBody): string {
	const contentType = response.headers.get("content-type") ?? "";
	if (body.truncated || !contentType.includes("json")) return body.text;
	try {
		return JSON.stringify(JSON.parse(body.text), null, 2);
	} catch (error: unknown) {
		// A server that labels non-JSON as JSON: show what it sent.
		if (error instanceof SyntaxError) return body.text;
		throw error;
	}
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: API_USAGE,
		parse: () => parseApiOptions(process.argv.slice(2)),
		run: callApi,
	});
