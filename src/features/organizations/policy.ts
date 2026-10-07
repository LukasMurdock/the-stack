import { z } from "zod";

export const memberRoleSchema = z.enum(["owner", "editor", "viewer"]);
// Owners require a separate transfer workflow; ordinary membership cannot assign or alter them.
export const assignableRoleSchema = memberRoleSchema.exclude(["owner"]);

type MemberRole = z.infer<typeof memberRoleSchema>;
export const permissionRoles = {
	read: memberRoleSchema.options,
	edit: ["owner", "editor"],
	manage: ["owner"],
} satisfies Record<string, MemberRole[]>;
export type OrganizationPermission = keyof typeof permissionRoles;

export function can(role: MemberRole, permission: OrganizationPermission) {
	return permissionRoles[permission].some((allowed) => allowed === role);
}

export function canManageMember(actorRole: MemberRole, targetRole: MemberRole) {
	return (
		can(actorRole, "manage") &&
		assignableRoleSchema.safeParse(targetRole).success
	);
}
