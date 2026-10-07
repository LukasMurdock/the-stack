import { PAGE_SIZE, pageSchema } from "../../contracts/pagination";
import { and, eq, inArray } from "drizzle-orm";
import { resourceIdSchema } from "../../contracts/operation";
import { membershipPredicate, requireMembership } from "./authorization";
import {
	commandInput,
	ProductError,
	type OperationContext,
} from "../shared/context";
import { auth_user, memberships } from "../../bindings/d1/core/schema";
import { assignableRoleSchema } from "./policy";
import {
	changeMemberSchema,
	memberTargetSchema,
} from "../../contracts/organizations";

export async function listMembers(
	context: OperationContext,
	organizationId: string,
	input: unknown = {}
) {
	const { offset } = commandInput(pageSchema, input);
	commandInput(resourceIdSchema, organizationId);
	await requireMembership(context, organizationId);
	return context.db
		.select({
			userId: memberships.userId,
			name: auth_user.name,
			email: auth_user.email,
			role: memberships.role,
		})
		.from(memberships)
		.innerJoin(auth_user, eq(auth_user.id, memberships.userId))
		.where(
			and(
				eq(memberships.organizationId, organizationId),
				membershipPredicate(context, organizationId, "read")
			)
		)
		.orderBy(auth_user.name)
		.limit(PAGE_SIZE)
		.offset(offset);
}
export async function changeMember(
	context: OperationContext,
	organizationId: string,
	userId: string,
	input: unknown
) {
	const target = commandInput(memberTargetSchema, { organizationId, userId });
	const command = commandInput(changeMemberSchema, input);
	await requireMembership(context, target.organizationId, "manage");
	const rows = await context.db
		.update(memberships)
		.set({ role: command.role })
		.where(
			and(
				eq(memberships.organizationId, target.organizationId),
				eq(memberships.userId, target.userId),
				inArray(memberships.role, assignableRoleSchema.options),
				membershipPredicate(context, target.organizationId, "manage")
			)
		)
		.returning();
	if (!rows.length)
		throw new ProductError(
			"not_found",
			"Editable member not found. The organization owner cannot be changed here."
		);
}
export async function removeMember(
	context: OperationContext,
	organizationId: string,
	userId: string
) {
	const target = commandInput(memberTargetSchema, { organizationId, userId });
	await requireMembership(context, target.organizationId, "manage");
	const rows = await context.db
		.delete(memberships)
		.where(
			and(
				eq(memberships.organizationId, target.organizationId),
				eq(memberships.userId, target.userId),
				inArray(memberships.role, assignableRoleSchema.options),
				membershipPredicate(context, target.organizationId, "manage")
			)
		)
		.returning();
	if (!rows.length)
		throw new ProductError(
			"not_found",
			"Removable member not found. The organization owner cannot be removed."
		);
}
