type ExceptionPlatform = "worker" | "client";

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const LONG_HEX_RE = /\b[0-9a-fA-F]{16,}\b/g;
const LONG_NUM_RE = /\b\d{5,}\b/g;
const WS_RE = /\s+/g;

function normalizeApiPath(p: string): string {
	let out = p;
	out = out.replace(/\b\d+\b/g, ":id");
	out = out.replace(UUID_RE, ":id");
	out = out.replace(LONG_HEX_RE, ":id");
	return out;
}

function normalizeMessage(input: string): string {
	let out = input.trim();
	out = out.replace(WS_RE, " ");
	out = out.replace(UUID_RE, "<id>");
	out = out.replace(LONG_HEX_RE, "<id>");
	out = out.replace(LONG_NUM_RE, "<num>");
	return out;
}

function normalizeStackKey(stack: string): string {
	const lines = stack
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean)
		.slice(0, 4);

	const outLines = lines.map((line) => {
		let out = line;
		// Strip querystrings in URLs to avoid cache-buster noise.
		out = out.replace(/(https?:\/\/[^\s)]+)\?[^\s)]*/g, "$1");
		// Normalize line/col numbers.
		out = out.replace(/:(\d+):(\d+)/g, ":#:#");
		out = out.replace(/:(\d+)\b/g, ":#");
		// Normalize hashed asset names (common bundlers).
		out = out.replace(/(-|\.)[0-9a-fA-F]{6,}(?=\.(js|mjs|cjs|css|map)\b)/g, "$1:hash");
		return out;
	});

	return outLines.join("\n");
}

async function sha256Hex(input: string): Promise<string> {
	const enc = new TextEncoder();
	const buf = await crypto.subtle.digest("SHA-256", enc.encode(input));
	const bytes = new Uint8Array(buf);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

async function fingerprintHttp5xx(input: {
	method: string;
	pathTemplate: string;
	status: number;
}): Promise<string> {
	const signature = `v1|worker|http_5xx|${input.method}|${input.pathTemplate}|${String(input.status)}`;
	return `v1:${await sha256Hex(signature)}`;
}

async function fingerprintException(input: {
	platform: ExceptionPlatform;
	message: string | null | undefined;
	stack: string | null | undefined;
	method?: string;
	pathTemplate?: string;
}): Promise<string> {
	const msgNorm = normalizeMessage(input.message ?? "unknown").slice(0, 300);
	const stackKey = input.stack ? normalizeStackKey(input.stack).slice(0, 800) : "";
	const method = input.method ? input.method : "";
	const path = input.pathTemplate ? input.pathTemplate : "";
	const signature = `v1|${input.platform}|exception|${method}|${path}|${msgNorm}|${stackKey}`;
	return `v1:${await sha256Hex(signature)}`;
}

export {
	normalizeApiPath,
	fingerprintHttp5xx,
	fingerprintException,
};
