import { and, desc, eq, sql } from "drizzle-orm";
import { organizations, projects } from "../../bindings/d1/core/schema";
import { createProjectSchema } from "./contracts";
import { resourceIdSchema } from "../../contracts/operation";
import { PAGE_SIZE, pageSchema } from "../../contracts/pagination";
import {
	membershipPredicate,
	requireMembership,
} from "../organizations/authorization";
import {
	commandInput,
	ProductError,
	type OperationContext,
} from "../shared/context";

export async function listProjects(
	context: OperationContext,
	organizationId: string,
	input: unknown = {}
) {
	commandInput(resourceIdSchema, organizationId);
	const { offset } = commandInput(pageSchema, input);
	await requireMembership(context, organizationId);
	return context.db
		.select()
		.from(projects)
		.where(
			and(
				eq(projects.organizationId, organizationId),
				membershipPredicate(context, organizationId, "read")
			)
		)
		.orderBy(desc(projects.createdAt), projects.id)
		.limit(PAGE_SIZE)
		.offset(offset);
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
