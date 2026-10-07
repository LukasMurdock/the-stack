import { PAGE_SIZE, pageSchema } from "../../contracts/pagination";
import { and, eq, sql } from "drizzle-orm";
import { memberships, organizations } from "../../bindings/d1/core/schema";
import { createOrganizationSchema } from "../../contracts/organizations";
import { resourceIdSchema } from "../../contracts/operation";
import {
	commandInput,
	ProductError,
	type OperationContext,
} from "../shared/context";

export async function listOrganizations(
	context: OperationContext,
	input: unknown = {}
) {
	const { offset } = commandInput(pageSchema, input);
	return context.db
		.select({
			id: organizations.id,
			name: organizations.name,
			role: memberships.role,
		})
		.from(organizations)
		.innerJoin(
			memberships,
			eq(memberships.organizationId, organizations.id)
		)
		.where(eq(memberships.userId, context.actor.userId))
		.orderBy(organizations.name, organizations.id)
		.limit(PAGE_SIZE)
		.offset(offset);
}
export async function getOrganization(
	context: OperationContext,
	organizationId: string
) {
	commandInput(resourceIdSchema, organizationId);
	const [organization] = await context.db
		.select({
			id: organizations.id,
			name: organizations.name,
			role: memberships.role,
		})
		.from(organizations)
		.innerJoin(
			memberships,
			eq(memberships.organizationId, organizations.id)
		)
		.where(
			and(
				eq(organizations.id, organizationId),
				eq(memberships.userId, context.actor.userId)
			)
		);
	if (!organization)
		throw new ProductError("not_found", "Organization not found.");
	return organization;
}
export async function createOrganization(
	context: OperationContext,
	input: unknown
) {
	const command = commandInput(createOrganizationSchema, input);
	const id = crypto.randomUUID();
	await context.db.batch([
		context.db.insert(organizations).values({
			id,
			name: command.name,
			createdBy: context.actor.userId,
			createdAt: Date.now(),
		}),
		context.db.insert(memberships).select(
			context.db
				.select({
					organizationId: organizations.id,
					userId: sql<string>`${context.actor.userId}`.as("userId"),
					role: sql<"owner">`'owner'`.as("role"),
				})
				.from(organizations)
				.where(eq(organizations.id, id))
		),
	]);
	return getOrganization(context, id);
}
