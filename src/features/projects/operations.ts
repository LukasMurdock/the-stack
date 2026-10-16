import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { organizations, projects } from "../../bindings/d1/core/schema";
import { createProjectSchema } from "./contracts";
import { resourceIdSchema } from "../../contracts/operation";
import { pageSchema } from "../../contracts/pagination";
import { insertionOrder } from "../../bindings/d1/insertion-order";
import {
	membershipPredicate,
	requireMembership,
} from "../organizations/authorization";
import {
	commandInput,
	ProductError,
	type OperationContext,
} from "../shared/context";
import { matchedRows, readPage } from "../shared/paging";

export async function listProjects(
	context: OperationContext,
	organizationId: string,
	input: unknown = {}
) {
	commandInput(resourceIdSchema, organizationId);
	const { offset } = commandInput(pageSchema, input);
	await requireMembership(context, organizationId);
	return readPage(
		context.db
			.select({ ...getTableColumns(projects), matched: matchedRows })
			.from(projects)
			.where(
				and(
					eq(projects.organizationId, organizationId),
					membershipPredicate(context, organizationId, "read")
				)
			)
			.orderBy(desc(projects.createdAt), desc(insertionOrder(projects))),
		offset
	);
}
export async function createProject(
	context: OperationContext,
	organizationId: string,
	input: unknown
) {
	commandInput(resourceIdSchema, organizationId);
	const fields = commandInput(createProjectSchema, input);
	await requireMembership(context, organizationId, "edit");
	const id = crypto.randomUUID();
	const rows = await context.db
		.insert(projects)
		.select(
			context.db
				.select({
					id: sql<string>`${id}`.as("id"),
					organizationId: organizations.id,
					name: sql<string>`${fields.name}`.as("name"),
					description: sql<string>`${fields.description}`.as(
						"description"
					),
					createdAt: sql<number>`${Date.now()}`.as("createdAt"),
				})
				.from(organizations)
				.where(
					and(
						eq(organizations.id, organizationId),
						membershipPredicate(context, organizationId, "edit")
					)
				)
		)
		.returning();
	if (!rows[0])
		throw new ProductError(
			"forbidden",
			"Your access changed. Reload and try again."
		);
	return rows[0];
}
