import { and, asc, eq, exists } from "drizzle-orm";
import type { TurretDb } from "../../../../bindings/d1/turret/db";
import {
	turretRequestSpans,
	turretRequestBreadcrumbs,
} from "../../../../bindings/d1/turret/schema";

export async function loadReplaySessionSpansGrouped(input: {
	db: TurretDb;
	sessionId: string;
	limit: number;
	offset: number;
}) {
	const { db, sessionId, limit, offset } = input;
	const rows = await db
		.select()
		.from(turretRequestSpans)
		.where(
			exists(
				db
					.select({ id: turretRequestBreadcrumbs.id })
					.from(turretRequestBreadcrumbs)
					.where(
						and(
							eq(turretRequestBreadcrumbs.sessionId, sessionId),
							eq(
								turretRequestBreadcrumbs.id,
								turretRequestSpans.breadcrumbId
							)
						)
					)
			)
		)
		.orderBy(asc(turretRequestSpans.createdAt), asc(turretRequestSpans.id))
		.limit(limit + 1)
		.offset(offset);
	const hasMore = rows.length > limit;
	const spansByBreadcrumbId: Record<string, typeof rows> = {};
	for (const span of rows.slice(0, limit)) {
		(spansByBreadcrumbId[span.breadcrumbId] ??= []).push(span);
	}
	return { spansByBreadcrumbId, hasMore };
}
