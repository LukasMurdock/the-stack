import { sql } from "drizzle-orm";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { batchSql } from "../../../bindings/d1/sql-batch";
import { makeCoreDb } from "../../../bindings/d1/core/db";
import { makeTurretDb } from "../../../bindings/d1/turret/db";
import { turretIssueActivityKindSchema } from "../../../contracts/turret";
import { isAdminRole } from "../../../features/auth/policy";
import type { Bindings } from "../../index";
import { issueActivity, issueHasEvidence } from "../../turret/issues";
import { readRecovery } from "../../turret/recovery";
import {
	adminErrorResponseSchema,
	adminErrorResponses,
	requireInternalTurretAdmin,
} from "./_shared/admin-auth";
import {
	errorResponses,
	operationErrorHandler,
	validationHook,
} from "./_shared/operation-http";
import { productErrors } from "../../../contracts/operation";

const app = new OpenAPIHono<{ Bindings: Bindings }>({
	defaultHook: validationHook,
});
app.onError(operationErrorHandler);

const notFound = {
	404: {
		description: "Issue not found",
		content: { "application/json": { schema: adminErrorResponseSchema } },
	},
};
const invalidInput = {
	[productErrors.invalid_input.status]:
		errorResponses[productErrors.invalid_input.status],
};
const fingerprintParam = z.object({ fingerprint: z.string() });

const ACTIVITY_MAX = 200;
const ASSIGNEES_MAX = 200;

async function issueExists(db: D1Database, fingerprint: string) {
	const row = await makeTurretDb(db).get<{ ok: number } | undefined>(
		sql`SELECT ${issueHasEvidence(fingerprint)} AS ok`
	);
	return Boolean(row?.ok);
}

const ActivitySchema = z
	.object({
		id: z.string(),
		actorId: z.string(),
		kind: turretIssueActivityKindSchema,
		detail: z.record(z.string(), z.unknown()),
		createdAt: z.number(),
	})
	.openapi("TurretIssueActivity");

const RecoveryPeriodSchema = z.object({
	from: z.number(),
	to: z.number(),
	sessions: z.number(),
	affected: z.number(),
});

const RecoverySchema = z
	.object({
		resolvedAt: z.number(),
		resolvedInVersionId: z.string().nullable(),
		before: RecoveryPeriodSchema,
		after: RecoveryPeriodSchema,
		verdict: z.enum([
			"no_baseline",
			"recurring",
			"insufficient_traffic",
			"likely_fixed",
		]),
		expectedAffected: z.number().nullable(),
		chanceUnchanged: z.number().nullable(),
	})
	.openapi("TurretIssueRecovery");

export const routes = app
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/assignees",
			middleware: [requireInternalTurretAdmin] as const,
			responses: {
				200: {
					description:
						"Administrators who can own issues, and the current administrator",
					content: {
						"application/json": {
							schema: z
								.object({
									assignees: z.array(
										z.object({
											id: z.string(),
											name: z.string(),
											email: z.string(),
										})
									),
									currentUserId: z.string(),
								})
								.openapi("TurretAssigneesResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			// Roles are comma-separated, so narrow in SQL and decide in policy.
			const users = await makeCoreDb(
				c.env.CORE_DB
			).query.auth_user.findMany({
				where: (t, ops) => ops.like(t.role, "%admin%"),
				columns: { id: true, name: true, email: true, role: true },
				orderBy: (t, ops) => [ops.asc(t.name), ops.asc(t.id)],
				limit: ASSIGNEES_MAX,
			});
			return c.json(
				{
					assignees: users
						.filter((user) => isAdminRole(user.role))
						.map(({ id, name, email }) => ({ id, name, email })),
					currentUserId: c.get("turretAdminId"),
				},
				200
			);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/activity",
			middleware: [requireInternalTurretAdmin] as const,
			request: { params: fingerprintParam },
			responses: {
				200: {
					description: "Notes and changes on an issue, newest first",
					content: {
						"application/json": {
							schema: z
								.object({ activity: z.array(ActivitySchema) })
								.openapi("TurretIssueActivityResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { fingerprint } = c.req.valid("param");
			const rows = await makeTurretDb(c.env.TURRET_DB).all<{
				id: string;
				actorId: string;
				kind: string;
				detailJson: string;
				createdAt: number;
			}>(sql`
				SELECT id, actor_id AS actorId, kind, detail_json AS detailJson,
					created_at AS createdAt
				FROM turret_issue_activity WHERE fingerprint = ${fingerprint}
				ORDER BY created_at DESC, id DESC
				LIMIT ${ACTIVITY_MAX}
			`);
			const activity = rows.map(({ detailJson, ...row }) =>
				ActivitySchema.parse({ ...row, detail: JSON.parse(detailJson) })
			);
			return c.json({ activity }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/internal/turret/issue/{fingerprint}/notes",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: fingerprintParam,
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object({
									body: z
										.string()
										.trim()
										.min(1, "Write a note.")
										.max(5000, {
											error: (issue) =>
												`Use ${issue.maximum} characters or fewer.`,
										}),
								})
								.openapi("TurretIssueNote"),
						},
					},
				},
			},
			responses: {
				200: {
					description: "Add an investigation note",
					content: {
						"application/json": {
							schema: z
								.object({ ok: z.literal(true) })
								.openapi("TurretIssueNoteResponse"),
						},
					},
				},
				...invalidInput,
				...adminErrorResponses,
				...notFound,
			},
		}),
		async (c) => {
			const { fingerprint } = c.req.valid("param");
			const { body } = c.req.valid("json");
			const [result] = await batchSql(c.env.TURRET_DB, [
				issueActivity({
					fingerprint,
					actorId: c.get("turretAdminId"),
					kind: "note",
					detail: { body },
					now: Date.now(),
				}),
			]);
			if (result.meta.changes === 0)
				return c.json({ error: "Not Found" }, 404);
			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "post",
			path: "/internal/turret/issue/{fingerprint}/links",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: fingerprintParam,
				body: {
					required: true,
					content: {
						"application/json": {
							schema: z
								.object({
									url: z
										.url({
											protocol: /^https?$/,
											error: "Use an http or https URL.",
										})
										.max(2000),
								})
								.openapi("TurretIssueLinkCreate"),
						},
					},
				},
			},
			responses: {
				200: {
					description:
						"Link a ticket, pull request, or other tracking URL; repeating a URL changes nothing",
					content: {
						"application/json": {
							schema: z
								.object({ ok: z.literal(true) })
								.openapi("TurretIssueLinkCreateResponse"),
						},
					},
				},
				...invalidInput,
				...adminErrorResponses,
				...notFound,
			},
		}),
		async (c) => {
			const { fingerprint } = c.req.valid("param");
			const { url } = c.req.valid("json");
			const now = Date.now();
			const actorId = c.get("turretAdminId");
			const results = await batchSql(c.env.TURRET_DB, [
				issueActivity({
					fingerprint,
					actorId,
					kind: "link_added",
					detail: { url },
					now,
					when: sql`NOT EXISTS (
						SELECT 1 FROM turret_issue_links
						WHERE fingerprint = ${fingerprint} AND url = ${url}
					)`,
				}),
				sql`
					INSERT INTO turret_issue_links (id, fingerprint, url, created_by, created_at)
					SELECT ${crypto.randomUUID()}, ${fingerprint}, ${url}, ${actorId}, ${now}
					WHERE ${issueHasEvidence(fingerprint)}
					ON CONFLICT(fingerprint, url) DO NOTHING
				`,
			]);
			if (
				(results.at(-1)?.meta.changes ?? 0) === 0 &&
				!(await issueExists(c.env.TURRET_DB, fingerprint))
			)
				return c.json({ error: "Not Found" }, 404);
			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "delete",
			path: "/internal/turret/issue/{fingerprint}/links/{linkId}",
			middleware: [requireInternalTurretAdmin] as const,
			request: {
				params: fingerprintParam.extend({ linkId: z.string() }),
			},
			responses: {
				200: {
					description: "Remove a tracking link",
					content: {
						"application/json": {
							schema: z
								.object({ ok: z.literal(true) })
								.openapi("TurretIssueLinkDeleteResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { fingerprint, linkId } = c.req.valid("param");
			const link = sql`(
				SELECT url FROM turret_issue_links
				WHERE id = ${linkId} AND fingerprint = ${fingerprint}
			)`;
			await batchSql(c.env.TURRET_DB, [
				// The activity row reads the URL before the link is deleted.
				sql`
					INSERT INTO turret_issue_activity (id, fingerprint, actor_id, kind, detail_json, created_at)
					SELECT ${crypto.randomUUID()}, ${fingerprint}, ${c.get("turretAdminId")},
						'link_removed', json_object('url', ${link}), ${Date.now()}
					WHERE ${link} IS NOT NULL
				`,
				sql`
					DELETE FROM turret_issue_links
					WHERE id = ${linkId} AND fingerprint = ${fingerprint}
				`,
			]);
			return c.json({ ok: true as const }, 200);
		}
	)
	.openapi(
		createRoute({
			method: "get",
			path: "/internal/turret/issue/{fingerprint}/recovery",
			middleware: [requireInternalTurretAdmin] as const,
			request: { params: fingerprintParam },
			responses: {
				200: {
					description:
						"Whether replay traffic since resolution supports the fix; null unless resolved",
					content: {
						"application/json": {
							schema: z
								.object({ recovery: RecoverySchema.nullable() })
								.openapi("TurretIssueRecoveryResponse"),
						},
					},
				},
				...adminErrorResponses,
			},
		}),
		async (c) => {
			const { fingerprint } = c.req.valid("param");
			const recovery = await readRecovery(
				makeTurretDb(c.env.TURRET_DB),
				fingerprint,
				Date.now()
			);
			return c.json({ recovery }, 200);
		}
	);
