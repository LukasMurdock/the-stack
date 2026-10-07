import { turretTimestampMsSchema } from "../../../contracts/turret-time-range";
import { persistError } from "../../turret/errors";
import { bodyLimit } from "hono/body-limit";
import {
	REPLAY_CHUNK_BYTES_MAX,
	jsonBytes,
} from "../../../contracts/turret-ingest";
import { telemetryExpiry, readRetainedReplay } from "../../turret/retention";
import { commitReplayChunk } from "../../turret/chunks";
import type { UploadTokenPayload } from "./_shared/turret-upload-token";
import type { MiddlewareHandler } from "hono";
import {
	turretReplayChunkSchema,
	turretInitResponseSchema,
} from "../../../contracts/turret";
import { getRequestLocation } from "../../../lib/cloudflareRequest";
import type { Bindings } from "../../index";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import * as schema from "../../../bindings/d1/turret/schema";
import { turretFeedbackBodySchema } from "../../../contracts/turret";
import { turretOutcomeBodySchema } from "../../../contracts/turret-outcomes";
import { recordOutcomeEvent } from "../../turret/outcomes";
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

type TurretEnv = {
	Bindings: Bindings;
	Variables: { upload: UploadTokenPayload };
};
const turretApp = new OpenAPIHono<TurretEnv>();

const requireTurretOrigin: MiddlewareHandler<{ Bindings: Bindings }> = async (
	c,
	next
) => {
	const reason = requiredSameOrigin(c.env.APP_URL, c.req.raw);
	if (reason) {
		return c.json({ error: "Forbidden", code: reason }, 403, {
			"Cache-Control": "no-store",
		});
	}
	await next();
};

// Upload endpoints share mode and token authorization, before request-body validation.
const requireUpload: MiddlewareHandler<TurretEnv> = async (c, next) => {
	const mode = resolveTurretModeStatus({
		modeRaw: c.env.TURRET_MODE,
		hasSigningKey: Boolean(c.env.TURRET_SIGNING_KEY),
	});
	if (!mode.ingestEnabled || !c.env.TURRET_SIGNING_KEY)
		return c.json(disabledIngestResponse(mode), 503, {
			"Cache-Control": "no-store",
		});
	const token = getBearerToken(c.req.raw);
	if (!token) return c.json({ error: "Unauthorized" }, 401);
	const payload = await verifyUploadToken(
		c.env.TURRET_SIGNING_KEY,
		token,
		Date.now()
	);
	if (!payload || payload.sid !== c.req.param("id"))
		return c.json({ error: "Unauthorized" }, 401);
	if (!(await readRetainedReplay(makeTurretDb(c.env.TURRET_DB), payload.sid)))
		return c.json({ error: "Unauthorized" }, 401);
	c.set("upload", payload);
	await next();
};
const chunkBodyLimit = bodyLimit({
	maxSize: REPLAY_CHUNK_BYTES_MAX,
	onError: (c) => c.json({ error: "Payload too large" }, 413),
});
const limitReplayChunk: MiddlewareHandler<TurretEnv> = async (c, next) => {
	// Hono's body limiter trusts Content-Length when present. Measure the stream even
	// when the header is missing or incorrect, before the JSON validator reads it.
	const headers = new Headers(c.req.raw.headers);
	// oxlint-disable-next-line drizzle/enforce-delete-with-where -- Removes request metadata, not a database row.
	headers.delete("Content-Length");
	c.req.raw = new Request(c.req.raw, { headers });
	return chunkBodyLimit(c, next);
};

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

const OkResponseSchema = z
	.object({
		ok: z.literal(true),
	})
	.openapi("OkResponse");

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

turretApp.post("/turret/session/init", requireTurretOrigin, (c) =>
	c.redirect("/api/turret/replay-session/init", 307)
);
turretApp.post("/turret/session/:id/blocked", requireTurretOrigin, (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/blocked`, 307)
);
turretApp.post("/turret/session/:id/error", requireTurretOrigin, (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/error`, 307)
);
turretApp.post("/turret/session/:id/chunk", requireTurretOrigin, (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/chunk`, 307)
);
turretApp.post("/turret/session/:id/feedback", requireTurretOrigin, (c) =>
	c.redirect(`/api/turret/replay-session/${c.req.param("id")}/feedback`, 307)
);

export { turretApp };

export const routes = turretApp
	.openapi(
		createRoute({
			method: "post",
			path: "/turret/replay-session/init",
			middleware: [requireTurretOrigin] as const,
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
							schema: z
								.object(turretInitResponseSchema.shape)
								.openapi("TurretInitResponse"),
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
		}),
		async (c) => {
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
			const session = await auth.api.getSession({
				headers: c.req.raw.headers,
			});
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

			const retentionExpiresAt =
				now + policy.retentionDays * 24 * 60 * 60 * 1000;
			const db = makeTurretDb(env.TURRET_DB);

			const initialUrl =
				init?.initial_url ?? c.req.header("Referer") ?? null;

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
							const signedUpWeekStartMs =
								startOfUtcWeekMs(signedUpAtMs);
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
					upload_expires_at: exp,
					policy_version: policy.version,
					rrweb: policy.rrweb,
					console: policy.console,
				},
				200,
				{
					"Cache-Control": "no-store",
				}
			);
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/turret/replay-session/{id}/blocked",
			middleware: [requireTurretOrigin, requireUpload] as const,
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
							schema: z
								.object({
									reason: z.string().optional(),
									message: z.string().optional(),
								})
								.openapi("TurretBlockedBody"),
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
		}),
		async (c) => {
			const env = c.env;
			const payload = c.get("upload");
			const sessionId = payload.sid;
			const body = c.req.valid("json");
			const reason = (body.reason ?? "rrweb_import_failed").slice(0, 64);
			const message = body.message ? body.message.slice(0, 512) : null;

			const now = Date.now();
			const db = makeTurretDb(env.TURRET_DB);

			await db
				.update(schema.turretSessions)
				.set({
					captureBlocked: true,
					captureBlockedReason: message
						? `${reason}:${message}`
						: reason,
					updatedAt: new Date(now),
				})
				.where(eq(schema.turretSessions.sessionId, sessionId));

			env.TURRET_ANALYTICS?.writeDataPoint({
				blobs: ["capture_blocked", payload.pv, reason],
				doubles: [1],
			});

			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/turret/replay-session/{id}/error",
			middleware: [requireTurretOrigin, requireUpload] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
				headers: z.object({
					authorization: z
						.string()
						.openapi({ example: "Bearer <token>" }),
				}),
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object({
									ts: turretTimestampMsSchema,
									source: z.string().optional(),
									message: z.string().optional(),
									stack: z.string().optional(),
									fingerprint: z.string().optional(),
									extra: z
										.record(z.string(), z.unknown())
										.optional(),
								})
								.openapi("TurretErrorBody"),
						},
					},
				},
			},
			responses: {
				200: {
					description: "Report a client error for a replay session",
					content: {
						"application/json": { schema: OkResponseSchema },
					},
				},
				401: {
					description: "Unauthorized",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
				500: {
					description: "Server misconfigured",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
				503: {
					description: "Turret ingestion unavailable",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const payload = c.get("upload");
			const sessionId = payload.sid;
			const body = c.req.valid("json");
			const now = Date.now();
			const db = makeTurretDb(env.TURRET_DB);

			let computedFingerprint = body.fingerprint || null;
			if (!computedFingerprint) {
				try {
					computedFingerprint = await fingerprintException({
						platform: "client",
						message: body.message,
						stack: body.stack,
					});
				} catch {
					computedFingerprint = null;
				}
			}

			await persistError(
				db,
				{
					sessionId,
					ts: new Date(body.ts),
					source: body.source ?? "client",
					message: body.message,
					stack: body.stack,
					fingerprint: computedFingerprint,
					extraJson: body.extra ? JSON.stringify(body.extra) : null,
				},
				now
			);

			env.TURRET_ANALYTICS?.writeDataPoint({
				blobs: ["client_error", payload.pv, body.source ?? "client"],
				doubles: [1],
			});

			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/turret/replay-session/{id}/chunk",
			middleware: [
				requireTurretOrigin,
				requireUpload,
				limitReplayChunk,
			] as const,
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
							schema: z
								.object(turretReplayChunkSchema.shape)
								.openapi("TurretChunkBody"),
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
				409: {
					description:
						"Sequence already committed with different content",
					content: {
						"application/json": { schema: ErrorResponseSchema },
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
		}),
		async (c) => {
			const env = c.env;
			const payload = c.get("upload");
			const sessionId = payload.sid;
			const body = c.req.valid("json");

			const result = await commitReplayChunk(
				makeTurretDb(env.TURRET_DB),
				env.TURRET_REPLAY_BUCKET,
				sessionId,
				body,
				Date.now()
			);
			if (result === "conflict")
				return c.json(
					{
						error: "Replay chunk already exists with different content.",
						code: "chunk_conflict",
					},
					409
				);

			env.TURRET_ANALYTICS?.writeDataPoint({
				blobs: [
					"chunk",
					payload.pv,
					getRequestLocation(c.req.raw).colo ?? "",
				],
				doubles: [1, jsonBytes(body)],
			});

			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/turret/replay-session/{id}/feedback",
			middleware: [requireTurretOrigin, requireUpload] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
				headers: z.object({
					authorization: z
						.string()
						.openapi({ example: "Bearer <token>" }),
				}),
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object(turretFeedbackBodySchema.shape)
								.openapi("TurretFeedbackBody"),
						},
					},
				},
			},
			responses: {
				200: {
					description: "Submit user feedback for a replay session",
					content: {
						"application/json": { schema: OkResponseSchema },
					},
				},
				401: {
					description: "Unauthorized",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
				500: {
					description: "Server misconfigured",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
				503: {
					description: "Turret ingestion unavailable",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
			},
		}),
		async (c) => {
			const env = c.env;
			const payload = c.get("upload");
			const sessionId = payload.sid;
			const body = c.req.valid("json");
			const now = Date.now();
			const db = makeTurretDb(env.TURRET_DB);

			// Best-effort lookup for session metadata to denormalize user.
			let userId = "";
			let userEmail: string | null = null;
			let expiresAt = telemetryExpiry(now);
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
				expiresAt = telemetryExpiry(now, session?.retentionExpiresAt);
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
				url: body.url || null,
				kind: body.kind,
				message: body.message,
				contact: body.contact || null,
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
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/turret/replay-session/{id}/outcome",
			middleware: [requireTurretOrigin, requireUpload] as const,
			request: {
				params: z.object({
					id: z.string().openapi({ example: "<session-id>" }),
				}),
				headers: z.object({
					authorization: z
						.string()
						.openapi({ example: "Bearer <token>" }),
				}),
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object(turretOutcomeBodySchema.shape)
								.openapi("TurretOutcomeBody"),
						},
					},
				},
			},
			responses: {
				200: {
					description:
						"Record a product workflow event for a replay session",
					content: {
						"application/json": { schema: OkResponseSchema },
					},
				},
				401: {
					description: "Unauthorized",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
				503: {
					description: "Turret ingestion unavailable",
					content: {
						"application/json": { schema: ErrorResponseSchema },
					},
				},
			},
		}),
		async (c) => {
			const payload = c.get("upload");
			const body = c.req.valid("json");
			// A missing session or an attempt owned by another session records
			// nothing; acknowledge so clients don't retry telemetry.
			await recordOutcomeEvent(
				makeTurretDb(c.env.TURRET_DB),
				payload.sid,
				body
			);
			c.env.TURRET_ANALYTICS?.writeDataPoint({
				blobs: ["workflow_outcome", body.workflow, body.event],
				doubles: [1],
			});
			return c.json({ ok: true as const }, 200);
		}
	);
