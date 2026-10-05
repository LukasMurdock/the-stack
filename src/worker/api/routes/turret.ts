import { turretInitResponseSchema } from "../../../contracts/turret";
import { getRequestLocation } from "../../../lib/cloudflareRequest";
import type { Bindings } from "../../index";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq, sql } from "drizzle-orm";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import * as schema from "../../../bindings/d1/turret/schema";
import { turretFeedbackKindSchema } from "../../../contracts/turret";
import { createAuth } from "../../auth";
import { readTurretFeatures } from "../../turret/features";
import {
	readTurretCompliance,
	normalizeTurretCompliance,
} from "../../turret/compliance";
import { fingerprintException } from "../../turret/fingerprinting";
import {
	resolveTurretModeStatus,
	type TurretModeStatus,
} from "../../turret/mode";
import { getBearerToken, requiredSameOrigin } from "./_shared/request-security";
import {
	signUploadToken,
	verifyUploadToken,
} from "./_shared/turret-upload-token";
import { startOfUtcWeekMs } from "./_shared/time";

const turretApp = new OpenAPIHono<{ Bindings: Bindings }>();

const ErrorResponseSchema = z
	.object({
		error: z.string(),
		code: z.string().optional(),
	})
	.openapi("ErrorResponse");

const InitBodySchema = z
	.object({
		journey_id: z.string().optional(),
		initial_url: z.string().optional(),
	})
	.openapi("TurretInitBody");

const InitResponseSchema = z
	.object(turretInitResponseSchema.shape)
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

const postReplaySessionBlocked = createRoute({
	method: "post",
	path: "/turret/replay-session/{id}/blocked",
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
			description: "Mark capture blocked for replay session",
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
		503: {
			description: "Turret ingestion unavailable",
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

const TurretFeedbackKindSchema = z
	.enum(turretFeedbackKindSchema.options)
	.openapi("TurretFeedbackKind");

const TurretFeedbackBodySchema = z
	.object({
		ts: z.number(),
		kind: TurretFeedbackKindSchema,
		message: z.string().min(1).max(4000),
		url: z.string().optional(),
		contact: z.string().optional(),
		extra: z.record(z.string(), z.unknown()).optional(),
	})
	.openapi("TurretFeedbackBody");

const postReplaySessionError = createRoute({
	method: "post",
	path: "/turret/replay-session/{id}/error",
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
			description: "Report a client error for a replay session",
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
		503: {
			description: "Turret ingestion unavailable",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

const postReplaySessionChunk = createRoute({
	method: "post",
	path: "/turret/replay-session/{id}/chunk",
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
		503: {
			description: "Turret ingestion unavailable",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

const postReplaySessionFeedback = createRoute({
	method: "post",
	path: "/turret/replay-session/{id}/feedback",
	request: {
		params: z.object({
			id: z.string().openapi({ example: "<session-id>" }),
		}),
		headers: z.object({
			authorization: z.string().openapi({ example: "Bearer <token>" }),
		}),
		body: {
			required: true,
			content: {
				"application/json": {
					schema: TurretFeedbackBodySchema,
				},
			},
		},
	},
	responses: {
		200: {
			description: "Submit user feedback for a replay session",
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
		503: {
			description: "Turret ingestion unavailable",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
	},
});

turretApp.use("/turret/*", async (c, next) => {
	const reason = requiredSameOrigin(c.env.APP_URL, c.req.raw);
	if (reason) {
		return c.json({ error: "Forbidden", code: reason }, 403, {
			"Cache-Control": "no-store",
		});
	}
	await next();
});

async function getComplianceBundle(env: { TURRET_CFG?: KVNamespace }) {
	if (!env.TURRET_CFG) return normalizeTurretCompliance({});
	return readTurretCompliance({ TURRET_CFG: env.TURRET_CFG });
}

function disabledIngestResponse(mode: TurretModeStatus): {
	error: string;
	code: string;
} {
	if (mode.effectiveMode === "off") {
		return {
			error: "Turret ingestion is disabled",
			code: "TURRET_DISABLED",
		};
	}

	if (mode.reason === "missing_turret_signing_key") {
		return {
			error: "Turret ingestion unavailable: missing signing key",
			code: "TURRET_DEGRADED_MISSING_SIGNING_KEY",
		};
	}

	return {
		error: "Turret ingestion is disabled in basic mode",
		code: "TURRET_BASIC_NO_INGEST",
	};
}

const postReplaySessionInit = createRoute({
	method: "post",
	path: "/turret/replay-session/init",
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
			description: "Initialize a Turret replay session",
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
		503: {
			description: "Turret ingestion unavailable",
			content: {
				"application/json": {
					schema: ErrorResponseSchema,
				},
			},
		},
	},
});

turretApp.post("/turret/session/init", (c) =>
	c.redirect("/api/turret/replay-session/init", 307)
);
turretApp.post("/turret/session/:id/blocked", (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/blocked`, 307)
);
turretApp.post("/turret/session/:id/error", (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/error`, 307)
);
turretApp.post("/turret/session/:id/chunk", (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/chunk`, 307)
);
turretApp.post("/turret/session/:id/feedback", (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/feedback`, 307)
);

turretApp.openapi(postReplaySessionInit, async (c) => {
	const now = Date.now();
	const env = c.env;
	const policy = await getComplianceBundle(env);
	const mode = resolveTurretModeStatus({
		modeRaw: env.TURRET_MODE,
		hasSigningKey: Boolean(env.TURRET_SIGNING_KEY),
	});
	if (!mode.ingestEnabled) {
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	}

	const contentType = c.req.header("Content-Type") ?? "";
	let init: z.infer<typeof InitBodySchema> | undefined;
	if (contentType.includes("application/json")) {
		try {
			init = c.req.valid("json");
		} catch {
			init = undefined;
		}
	}

	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session?.user) return c.json({ error: "Unauthorized" }, 401);

	const sessionId = crypto.randomUUID();
	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) {
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	}

	const exp = now + 15 * 60 * 1000;
	const uploadToken = await signUploadToken(signingKey, {
		sid: sessionId,
		exp,
		pv: policy.version,
	});

	const retentionExpiresAt = now + policy.retentionDays * 24 * 60 * 60 * 1000;
	const db = makeTurretDb(env.TURRET_DB);

	const initialUrl = init?.initial_url ?? c.req.header("Referer") ?? null;

	const { storeUserEmail } = await readTurretFeatures(env);

	const {
		id: versionId,
		tag: versionTag,
		timestamp: versionTimestamp,
	} = env.CF_VERSION_METADATA ?? {
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
		userId: session.user.id,
		userEmail: storeUserEmail ? (session.user.email ?? null) : null,
		workerVersionId: versionId || null,
		workerVersionTag: versionTag || null,
		workerVersionTimestamp: versionTimestamp || null,
		userAgent: c.req.header("User-Agent") ?? null,
		country: getRequestLocation(c.req.raw).country ?? null,
		colo: getRequestLocation(c.req.raw).colo ?? null,
		hasError: false,
		captureBlocked: false,
		captureBlockedReason: null,
		errorCount: 0,
		chunkCount: 0,
		policyVersion: policy.version,
		retentionExpiresAt: new Date(retentionExpiresAt),
		endedAt: null,
	});

	// Best-effort analytics side effects.
	// - cache user signup week in TURRET_DB for retention calculations
	// - record weekly activity bit for this user
	try {
		const userId = session.user.id;
		const weekStartMs = startOfUtcWeekMs(now);
		await env.TURRET_DB.prepare(
			"INSERT OR IGNORE INTO turret_user_activity_weekly (user_id, week_start_ms, first_seen_at) VALUES (?, ?, ?)"
		)
			.bind(userId, weekStartMs, now)
			.run();

		const existingProfile = await env.TURRET_DB.prepare(
			"SELECT user_id FROM turret_user_profile WHERE user_id = ? LIMIT 1"
		)
			.bind(userId)
			.first();
		if (!existingProfile) {
			const row = await env.CORE_DB.prepare(
				"SELECT created_at FROM auth_user WHERE id = ? LIMIT 1"
			)
				.bind(userId)
				.first<{ created_at: number }>();
			if (row?.created_at != null) {
				const signedUpAtMs = Number(row.created_at);
				if (Number.isFinite(signedUpAtMs)) {
					const signedUpWeekStartMs = startOfUtcWeekMs(signedUpAtMs);
					await env.TURRET_DB.prepare(
						"INSERT OR IGNORE INTO turret_user_profile (user_id, signed_up_at_ms, signed_up_week_start_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
					)
						.bind(
							userId,
							signedUpAtMs,
							signedUpWeekStartMs,
							now,
							now
						)
						.run();
				}
			}
		}
	} catch {
		// ignore
	}

	env.TURRET_ANALYTICS?.writeDataPoint({
		blobs: [
			"session_init",
			policy.version,
			getRequestLocation(c.req.raw).colo ?? "",
		],
		doubles: [1],
	});

	return c.json(
		{
			session_id: sessionId,
			upload_token: uploadToken,
			policy_version: policy.version,
			rrweb: policy.rrweb,
			console: policy.console ?? {
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

turretApp.openapi(postReplaySessionBlocked, async (c) => {
	const env = c.env;
	const mode = resolveTurretModeStatus({
		modeRaw: env.TURRET_MODE,
		hasSigningKey: Boolean(env.TURRET_SIGNING_KEY),
	});
	if (!mode.ingestEnabled) {
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	}

	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json(disabledIngestResponse(mode), 503);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId)
		return c.json({ error: "Unauthorized" }, 401);

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

turretApp.openapi(postReplaySessionError, async (c) => {
	const env = c.env;
	const mode = resolveTurretModeStatus({
		modeRaw: env.TURRET_MODE,
		hasSigningKey: Boolean(env.TURRET_SIGNING_KEY),
	});
	if (!mode.ingestEnabled) {
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	}

	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json(disabledIngestResponse(mode), 503);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId)
		return c.json({ error: "Unauthorized" }, 401);

	const body = c.req.valid("json");
	const now = Date.now();
	const db = makeTurretDb(env.TURRET_DB);

	let computedFingerprint: string | null = body.fingerprint
		? body.fingerprint.slice(0, 256)
		: null;
	if (!computedFingerprint) {
		try {
			computedFingerprint = (
				await fingerprintException({
					platform: "client",
					message: body.message,
					stack: body.stack,
				})
			).slice(0, 256);
		} catch {
			computedFingerprint = null;
		}
	}

	let expiresAt = now + 24 * 60 * 60 * 1000;
	try {
		const session = await db.query.turretSessions.findFirst({
			where: (t, ops) => ops.eq(t.sessionId, sessionId),
			columns: { retentionExpiresAt: true },
		});
		const ret = session?.retentionExpiresAt;
		if (ret instanceof Date) expiresAt = ret.getTime();
	} catch {
		// keep default
	}

	await db.insert(schema.turretSessionErrors).values({
		id: crypto.randomUUID(),
		sessionId,
		ts: new Date(body.ts),
		source: (body.source ?? "client").slice(0, 64),
		message: body.message ? body.message.slice(0, 2000) : null,
		stack: body.stack ? body.stack.slice(0, 20000) : null,
		fingerprint: computedFingerprint,
		extraJson: body.extra ? JSON.stringify(body.extra) : null,
		expiresAt: new Date(expiresAt),
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

turretApp.openapi(postReplaySessionChunk, async (c) => {
	const env = c.env;
	const mode = resolveTurretModeStatus({
		modeRaw: env.TURRET_MODE,
		hasSigningKey: Boolean(env.TURRET_SIGNING_KEY),
	});
	if (!mode.ingestEnabled) {
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	}

	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json(disabledIngestResponse(mode), 503);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId)
		return c.json({ error: "Unauthorized" }, 401);

	// Hard payload cap (adjust later). If Content-Length is missing, we still parse but may reject on JSON size.
	const contentLength = Number(c.req.header("Content-Length") ?? "0");
	if (contentLength && contentLength > 512_000)
		return c.json({ error: "Payload too large" }, 413);

	const body = c.req.valid("json");

	let rrwebMinTs: number | null = null;
	let rrwebMaxTs: number | null = null;
	for (const ev of body.events) {
		if (!ev || typeof ev !== "object" || !("timestamp" in ev)) continue;
		const ts = ev.timestamp;
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
		blobs: ["chunk", payload.pv, getRequestLocation(c.req.raw).colo ?? ""],
		doubles: [1, chunkJson.length],
	});

	return c.json({ ok: true as const }, 200);
});

turretApp.openapi(postReplaySessionFeedback, async (c) => {
	const env = c.env;
	const mode = resolveTurretModeStatus({
		modeRaw: env.TURRET_MODE,
		hasSigningKey: Boolean(env.TURRET_SIGNING_KEY),
	});
	if (!mode.ingestEnabled) {
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	}

	const signingKey = env.TURRET_SIGNING_KEY;
	if (!signingKey) return c.json(disabledIngestResponse(mode), 503);

	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);

	const { id: sessionId } = c.req.valid("param");
	const payload = await verifyUploadToken(signingKey, token, Date.now());
	if (!payload || payload.sid !== sessionId)
		return c.json({ error: "Unauthorized" }, 401);

	const body = c.req.valid("json");
	const now = Date.now();
	const db = makeTurretDb(env.TURRET_DB);

	// Best-effort lookup for session metadata to denormalize user.
	let userId = "";
	let userEmail: string | null = null;
	let expiresAt = now + 24 * 60 * 60 * 1000;
	try {
		const session = await db.query.turretSessions.findFirst({
			where: (t, ops) => ops.eq(t.sessionId, sessionId),
			columns: {
				userId: true,
				userEmail: true,
				retentionExpiresAt: true,
			},
		});
		userId = session?.userId ?? "";
		userEmail = session?.userEmail ?? null;
		const ret = session?.retentionExpiresAt;
		if (ret instanceof Date) expiresAt = ret.getTime();
	} catch {
		// ignore; keep defaults
	}

	if (!userId) {
		// Session should exist, but if not, fail closed.
		return c.json({ error: "Unauthorized" }, 401);
	}

	await db.insert(schema.turretUserFeedback).values({
		id: crypto.randomUUID(),
		sessionId,
		userId,
		userEmail,
		ts: new Date(body.ts),
		url: body.url ? body.url.slice(0, 2000) : null,
		kind: body.kind,
		message: body.message.slice(0, 4000),
		contact: body.contact ? body.contact.slice(0, 320) : null,
		extraJson: body.extra ? JSON.stringify(body.extra) : null,
		status: "open",
		expiresAt: new Date(expiresAt),
		createdAt: new Date(now),
		updatedAt: new Date(now),
	});

	env.TURRET_ANALYTICS?.writeDataPoint({
		blobs: ["user_feedback", payload.pv, body.kind],
		doubles: [1],
	});

	return c.json({ ok: true as const }, 200);
});

export { turretApp };
export const routes = turretApp;
