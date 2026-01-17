import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import * as schema from "../../../bindings/d1/turret/schema";
import { createAuth, type AuthEnv } from "../../auth";

const turretApp = new OpenAPIHono();

type D1Database = globalThis.D1Database;


const ErrorResponseSchema = z
	.object({
		error: z.string(),
	})
	.openapi("ErrorResponse");

const InitBodySchema = z
	.object({
		journey_id: z.string().optional(),
		initial_url: z.string().optional(),
	})
	.openapi("TurretInitBody");

const InitResponseSchema = z
	.object({
		session_id: z.string(),
		upload_token: z.string(),
		policy_version: z.string(),
		rrweb: z.unknown(),
		console: z
			.object({
				enabled: z.boolean().default(true),
				level: z.array(z.string()).default(["log", "info", "warn", "error"]),
				lengthThreshold: z.number().int().min(0).default(200),
				stringifyOptions: z
					.object({
						stringLengthLimit: z.number().int().optional(),
						numOfKeysLimit: z.number().int().min(0).default(30),
						depthOfLimit: z.number().int().min(0).default(2),
					})
					.default({ numOfKeysLimit: 30, depthOfLimit: 2 }),
			})
			.default({
				enabled: true,
				level: ["log", "info", "warn", "error"],
				lengthThreshold: 200,
				stringifyOptions: { numOfKeysLimit: 30, depthOfLimit: 2 },
			}),
	})
	.openapi("TurretInitResponse");

const OkResponseSchema = z
	.object({
		ok: z.literal(true),
	})
	.openapi("OkResponse");

const TurretBlockedBodySchema = z
	.object({
		reason: z.string().optional(),
		message: z.string().optional(),
	})
	.openapi("TurretBlockedBody");

const postSessionBlocked = createRoute({
	method: "post",
	path: "/turret/session/{id}/blocked",
	request: {
		params: z.object({
			id: z.string().openapi({
				example: "<session-id>",
			}),
		}),
		headers: z.object({
			authorization: z.string().openapi({
				example: "Bearer <token>",
			}),
		}),
		body: {
			required: true,
			content: {
				"application/json": {
					schema: TurretBlockedBodySchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: "Mark capture blocked for session",
			content: {
				"application/json": {
					schema: OkResponseSchema,
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
		500: {
			description: "Server misconfigured",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

const TurretChunkBodySchema = z
	.object({
		seq: z.number().int().min(0),
		events: z.array(z.unknown()),
		ts_start: z.number().optional(),
		ts_end: z.number().optional(),
	})
	.openapi("TurretChunkBody");

const TurretErrorBodySchema = z
	.object({
		ts: z.number(),
		source: z.string().optional(),
		message: z.string().optional(),
		stack: z.string().optional(),
		fingerprint: z.string().optional(),
		extra: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("TurretErrorBody");

const postSessionError = createRoute({
	method: "post",
	path: "/turret/session/{id}/error",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
		headers: z.object({
			authorization: z.string().openapi({ example: "Bearer <token>" }),
		}),
		body: {
			required: true,
			content: { "application/json": { schema: TurretErrorBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Report a client error for a session",
			content: { "application/json": { schema: OkResponseSchema } },
		},
		401: {
			description: "Unauthorized",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		500: {
			description: "Server misconfigured",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

const postSessionChunk = createRoute({
	method: "post",
	path: "/turret/session/{id}/chunk",
	request: {
		params: z.object({
			id: z.string().openapi({
				example: "<session-id>",
			}),
		}),
		headers: z.object({
			authorization: z.string().openapi({
				example: "Bearer <token>",
			}),
			"content-length": z.string().optional().openapi({}),
		}),
		body: {
			required: true,
			content: {
				"application/json": {
					schema: TurretChunkBodySchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: "Upload a replay chunk",
			content: {
				"application/json": {
					schema: OkResponseSchema,
				},
			},
		},
		400: {
			description: "Bad Request",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
		413: {
			description: "Payload too large",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
		500: {
			description: "Server misconfigured",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

function requiredSameOrigin(appUrl: string | undefined, req: Request): string | null {
	if (!appUrl) return "APP_URL not set";
	const allowedOrigin = new URL(appUrl).origin;

	const secFetchSite = req.headers.get("Sec-Fetch-Site");
	if (secFetchSite === "cross-site") return "cross-site";

	const origin = req.headers.get("Origin");
	if (origin && origin !== allowedOrigin) return "origin_mismatch";

	return null;
}

turretApp.use("/turret/*", async (c, next) => {
	const reason = requiredSameOrigin((c.env as { APP_URL?: string }).APP_URL, c.req.raw);
	if (reason) {
		return c.json(
			{ error: "Forbidden" },
			403,
			{ "Cache-Control": "no-store" }
		);
	}
	await next();
});

function getBearerToken(req: Request): string | null {
	const auth = req.headers.get("Authorization") ?? "";
	const m = auth.match(/^Bearer\s+(.+)$/i);
	return m ? m[1] : null;
}

type UploadTokenPayload = {
	sid: string;
	exp: number;
	pv: string;
};

function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	const b64 = btoa(binary);
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeToBytes(b64url: string): Uint8Array {
	const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
	const keyBytes = new TextEncoder().encode(key);
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		keyBytes,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
	const bytes = new Uint8Array(sig);
	let hex = "";
	for (const b of bytes) hex += b.toString(16).padStart(2, "0");
	return hex;
}

function timingSafeEqual(a: string, b: string): boolean {
	let diff = a.length ^ b.length;
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		diff |= (a.charCodeAt(i) ?? 0) ^ (b.charCodeAt(i) ?? 0);
	}
	return diff === 0;
}

async function signUploadToken(key: string, payload: UploadTokenPayload): Promise<string> {
	const payloadJson = JSON.stringify(payload);
	const payloadB64 = base64UrlEncode(new TextEncoder().encode(payloadJson));
	const sigHex = await hmacSha256Hex(key, payloadB64);
	return `${payloadB64}.${sigHex}`;
}

async function verifyUploadToken(
	key: string,
	token: string,
	nowMs: number
): Promise<UploadTokenPayload | null> {
	const parts = token.split(".");
	if (parts.length !== 2) return null;
	const [payloadB64, sigHex] = parts;

	const expected = await hmacSha256Hex(key, payloadB64);
	if (!timingSafeEqual(sigHex, expected)) return null;

	const payloadJson = new TextDecoder().decode(base64UrlDecodeToBytes(payloadB64));
	let payload: UploadTokenPayload;
	try {
		payload = JSON.parse(payloadJson) as UploadTokenPayload;
	} catch {
		return null;
	}

	if (!payload.sid || !payload.exp || !payload.pv) return null;
	if (nowMs >= payload.exp) return null;

	return payload;
}

async function getComplianceBundle(env: { TURRET_CFG?: { get(key: string, type: "json"): Promise<unknown> } }): Promise<{
	version: string;
	retentionDays: number;
	rrweb: unknown;
	console: {
		enabled: boolean;
		level: string[];
		lengthThreshold: number;
		stringifyOptions: {
			stringLengthLimit?: number;
			numOfKeysLimit: number;
			depthOfLimit: number;
		};
	};
}> {
	// Minimal default policy. You can make this richer later.
	const fallback = {
		version: "v1",
		retentionDays: 14,
		rrweb: {
			maskAllInputs: true,
		},
		console: {
			enabled: true,
			level: ["log", "info", "warn", "error"],
			lengthThreshold: 200,
			stringifyOptions: {
				stringLengthLimit: 300,
				numOfKeysLimit: 30,
				depthOfLimit: 2,
			},
		},
	};

	const cfg = (await env.TURRET_CFG?.get?.("cfg:compliance:active", "json")) as
		| { version?: string; retentionDays?: number; rrweb?: unknown }
		| null
		| undefined;
	if (!cfg) return fallback;
	return {
		version: cfg.version ?? fallback.version,
		retentionDays: cfg.retentionDays ?? fallback.retentionDays,
		rrweb: cfg.rrweb ?? fallback.rrweb,
		console: (cfg as any).console ?? fallback.console,
	};
}

const postSessionInit = createRoute({
	method: "post",
	path: "/turret/session/init",
	request: {
		body: {
			content: {
				"application/json": {
					schema: InitBodySchema,
				},
			},
			required: false,
		},
	},
	responses: {
		200: {
			description: "Initialize a Turret session",
			content: {
				"application/json": {
					schema: InitResponseSchema,
				},
			},
		},
		401: {
			description: "Unauthorized",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
		500: {
			description: "Server misconfigured",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

turretApp.openapi(postSessionInit, async (c) => {
	const now = Date.now();
	const env = c.env as unknown as AuthEnv & {
		APP_URL?: string;
		TURRET_CFG: { get(key: string, type: "json"): Promise<unknown> };
		TURRET_DB: D1Database;
		TURRET_SIGNING_KEY?: string;
		TURRET_REPLAY_BUCKET: { put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<void> };
		TURRET_ANALYTICS?: { writeDataPoint(input: { blobs: string[]; doubles: number[] }): void };
		CF_VERSION_METADATA?: { id?: string; tag?: string; timestamp?: string };
	};
	const policy = await getComplianceBundle(env);

	const contentType = c.req.header("Content-Type") ?? "";
	let init: z.infer<typeof InitBodySchema> | undefined;
	if (contentType.includes("application/json")) {
		try {
			init = c.req.valid("json");
		} catch {
			init = undefined;
		}
	}

	const auth = createAuth(env as unknown as AuthEnv, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) return c.json({ error: "Unauthorized" }, 401);

	const sessionId = crypto.randomUUID();
	const signingKey = env.TURRET_SIGNING_KEY as string | undefined;
	if (!signingKey) return c.json({ error: "Server misconfigured" }, 500);

	const exp = now + 15 * 60 * 1000;
	const uploadToken = await signUploadToken(signingKey, {
		sid: sessionId,
		exp,
		pv: policy.version,
	});

	const retentionExpiresAt = now + policy.retentionDays * 24 * 60 * 60 * 1000;
	const db = makeTurretDb(env.TURRET_DB);

	const initialUrl = init?.initial_url ?? c.req.header("Referer") ?? null;

	const featuresRaw = (await env.TURRET_CFG.get(
		"cfg:turret:features",
		"json"
	)) as { storeUserEmail?: boolean } | null;
	const storeUserEmail = featuresRaw?.storeUserEmail === true;

	const { id: versionId, tag: versionTag, timestamp: versionTimestamp } =
		env.CF_VERSION_METADATA ?? {
			id: "",
			tag: "",
			timestamp: "",
		};

	await db.insert(schema.turretSessions).values({
		sessionId,
		startedAt: new Date(now),
		createdAt: new Date(now),
		updatedAt: new Date(now),
		rrwebStartTsMs: null,
		rrwebLastTsMs: null,
		initialUrl,
		lastUrl: initialUrl,
		journeyId: init?.journey_id ?? null,
		userId: (session.user as unknown as { id: string }).id,
		userEmail: storeUserEmail ? (session.user as unknown as { email?: string | null }).email ?? null : null,
		workerVersionId: versionId || null,
		workerVersionTag: versionTag || null,
		workerVersionTimestamp: versionTimestamp || null,
		userAgent: c.req.header("User-Agent") ?? null,
		country: ((c.req.raw as unknown as { cf?: { country?: string } }).cf?.country ?? null) as string | null,
		colo: ((c.req.raw as unknown as { cf?: { colo?: string } }).cf?.colo ?? null) as string | null,
		hasError: false,
		captureBlocked: false,
		captureBlockedReason: null,
		errorCount: 0,
		chunkCount: 0,
		policyVersion: policy.version,
		retentionExpiresAt: new Date(retentionExpiresAt),
		endedAt: null,
	});

		env.TURRET_ANALYTICS?.writeDataPoint({
			blobs: [
				"session_init",
				policy.version,
				((c.req.raw as unknown as { cf?: { colo?: string } }).cf?.colo ?? "") as string,
			],
			doubles: [1],
		});


	return c.json(
		{
			session_id: sessionId,
			upload_token: uploadToken,
			policy_version: policy.version,
			rrweb: policy.rrweb,
			console: (policy as unknown as { console?: unknown }).console ?? {
				enabled: true,
				level: ["log", "info", "warn", "error"],
				lengthThreshold: 200,
				stringifyOptions: { numOfKeysLimit: 30, depthOfLimit: 2 },
			},
		},
		200,
		{
			"Cache-Control": "no-store",
		}
	);
});

turretApp.openapi(postSessionBlocked, async (c) => {
	const env = c.env as unknown as {
		TURRET_DB: D1Database;
		TURRET_SIGNING_KEY?: string;
		TURRET_ANALYTICS?: { writeDataPoint(input: { blobs: string[]; doubles: number[] }): void };
	};
	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json({ error: "Server misconfigured" }, 500);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId) return c.json({ error: "Unauthorized" }, 401);

	const body = c.req.valid("json");
	const reason = (body.reason ?? "rrweb_import_failed").slice(0, 64);
	const message = body.message ? body.message.slice(0, 512) : null;

	const now = Date.now();
	const db = makeTurretDb(env.TURRET_DB);

	await db
		.update(schema.turretSessions)
		.set({
			captureBlocked: true,
			captureBlockedReason: message ? `${reason}:${message}` : reason,
			updatedAt: new Date(now),
		})
		.where(eq(schema.turretSessions.sessionId, sessionId));

	env.TURRET_ANALYTICS?.writeDataPoint({
		blobs: ["capture_blocked", payload.pv, reason],
		doubles: [1],
	});

	return c.json({ ok: true as const }, 200);
});

turretApp.openapi(postSessionError, async (c) => {
	const env = c.env as unknown as {
		TURRET_DB: D1Database;
		TURRET_SIGNING_KEY?: string;
		TURRET_ANALYTICS?: { writeDataPoint(input: { blobs: string[]; doubles: number[] }): void };
	};
	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json({ error: "Server misconfigured" }, 500);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId) return c.json({ error: "Unauthorized" }, 401);

	const body = c.req.valid("json");
	const now = Date.now();
	const db = makeTurretDb(env.TURRET_DB);

	await db.insert(schema.turretSessionErrors).values({
		id: crypto.randomUUID(),
		sessionId,
		ts: new Date(body.ts),
		source: (body.source ?? "client").slice(0, 64),
		message: body.message ? body.message.slice(0, 2000) : null,
		stack: body.stack ? body.stack.slice(0, 20000) : null,
		fingerprint: body.fingerprint ? body.fingerprint.slice(0, 256) : null,
		extraJson: body.extra ? JSON.stringify(body.extra) : null,
		createdAt: new Date(now),
	});

	await db
		.update(schema.turretSessions)
		.set({
			hasError: true,
			errorCount: sql`${schema.turretSessions.errorCount} + 1`,
			updatedAt: new Date(now),
		})
		.where(eq(schema.turretSessions.sessionId, sessionId));

	env.TURRET_ANALYTICS?.writeDataPoint({
		blobs: ["client_error", payload.pv, body.source ?? "client"],
		doubles: [1],
	});

	return c.json({ ok: true as const }, 200);
});

turretApp.openapi(postSessionChunk, async (c) => {
	const env = c.env as unknown as {
		TURRET_DB: D1Database;
		TURRET_SIGNING_KEY?: string;
		TURRET_REPLAY_BUCKET: { put(key: string, value: string, options: { httpMetadata: { contentType: string } }): Promise<void> };
		TURRET_ANALYTICS?: { writeDataPoint(input: { blobs: string[]; doubles: number[] }): void };
	};
	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json({ error: "Server misconfigured" }, 500);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId) return c.json({ error: "Unauthorized" }, 401);

	// Hard payload cap (adjust later). If Content-Length is missing, we still parse but may reject on JSON size.
	const contentLength = Number(c.req.header("Content-Length") ?? "0");
	if (contentLength && contentLength > 512_000) return c.json({ error: "Payload too large" }, 413);

	const body = c.req.valid("json");

	let rrwebMinTs: number | null = null;
	let rrwebMaxTs: number | null = null;
	for (const ev of body.events) {
		if (!ev || typeof ev !== "object") continue;
		const ts = (ev as { timestamp?: unknown }).timestamp;
		if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
		rrwebMinTs = rrwebMinTs == null ? ts : Math.min(rrwebMinTs, ts);
		rrwebMaxTs = rrwebMaxTs == null ? ts : Math.max(rrwebMaxTs, ts);
	}

	const r2Key = `replay/v1/${sessionId}/chunk/${String(body.seq).padStart(8, "0")}.json`;
	const chunkJson = JSON.stringify(body);

	await env.TURRET_REPLAY_BUCKET.put(r2Key, chunkJson, {
		httpMetadata: { contentType: "application/json" },
	});

	const now = Date.now();
	const db = makeTurretDb(env.TURRET_DB);

	await db.insert(schema.turretSessionChunks).values({
		sessionId,
		seq: body.seq,
		r2Key,
		size: chunkJson.length,
		sha256: null,
		createdAt: new Date(now),
	});

	await db
		.update(schema.turretSessions)
		.set({
			chunkCount: sql`${schema.turretSessions.chunkCount} + 1`,
			rrwebStartTsMs:
				rrwebMinTs == null
					? schema.turretSessions.rrwebStartTsMs
					: sql`CASE
						WHEN ${schema.turretSessions.rrwebStartTsMs} IS NULL THEN ${rrwebMinTs}
						ELSE min(${schema.turretSessions.rrwebStartTsMs}, ${rrwebMinTs})
					END`,
			rrwebLastTsMs:
				rrwebMaxTs == null
					? schema.turretSessions.rrwebLastTsMs
					: sql`CASE
						WHEN ${schema.turretSessions.rrwebLastTsMs} IS NULL THEN ${rrwebMaxTs}
						ELSE max(${schema.turretSessions.rrwebLastTsMs}, ${rrwebMaxTs})
					END`,
			updatedAt: new Date(now),
		})
		.where(eq(schema.turretSessions.sessionId, sessionId));

		env.TURRET_ANALYTICS?.writeDataPoint({
			blobs: [
				"chunk",
				payload.pv,
				((c.req.raw as unknown as { cf?: { colo?: string } }).cf?.colo ?? "") as string,
			],
			doubles: [1, chunkJson.length],
		});


	return c.json({ ok: true as const }, 200);
});

export { turretApp };
export const routes = turretApp;
