import { and, eq, inArray, exists } from "drizzle-orm";
import { memberships } from "../../bindings/d1/core/schema";
import type { OperationContext } from "../shared/context";
import { ProductError } from "../shared/context";

import { can, permissionRoles, type OrganizationPermission } from "./policy";

// Keep authorization in the write predicate: membership can change after a read.
export function membershipPredicate(
	context: OperationContext,
	organizationId: string,
	permission: OrganizationPermission
) {
	return exists(
		context.db
			.select({ userId: memberships.userId })
			.from(memberships)
			.where(
				and(
					eq(memberships.organizationId, organizationId),
					eq(memberships.userId, context.actor.userId),
					inArray(memberships.role, permissionRoles[permission])
				)
			)
	);
}
export async function requireMembership(
	context: OperationContext,
	organizationId: string,
	permission: OrganizationPermission = "read"
) {
	const [member] = await context.db
		.select({ role: memberships.role })
		.from(memberships)
		.where(
			and(
				eq(memberships.organizationId, organizationId),
				eq(memberships.userId, context.actor.userId)
			)
		);
	if (!member) throw new ProductError("not_found", "Organization not found.");
	if (!can(member.role, permission)) {
		throw new ProductError(
			"forbidden",
			"You do not have permission to make this change."
		);
	}

	return member;
}
