import { z } from "zod";
import { passwordSchema } from "./auth";
import { resourceIdSchema } from "./operation";
import {
	memberRoleSchema,
	assignableRoleSchema,
} from "../features/organizations/policy";

export const createOrganizationSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Enter a name.")
		.max(120, {
			error: (issue) => `Use ${issue.maximum} characters or fewer.`,
		}),
});
export const organizationSchema = z.object({
	id: resourceIdSchema,
	name: z.string(),
	role: memberRoleSchema,
});
export const organizationsResponseSchema = z.object({
	organizations: z.array(organizationSchema),
});
export const organizationResponseSchema = z.object({
	organization: organizationSchema,
});
export const inviteMemberSchema = z.object({
	email: z.string().trim().toLowerCase().max(254).email(),
	role: assignableRoleSchema,
});
export const invitationResponseSchema = z.object({
	invitation: z.object({
		id: resourceIdSchema,
		token: z.string(),
		expiresAt: z.number(),
	}),
});
export const invitationsResponseSchema = z.object({
	invitations: z.array(
		z.object({
			id: resourceIdSchema,
			email: z.string(),
			role: assignableRoleSchema,
			expiresAt: z.number(),
		})
	),
});
export const acceptInvitationSchema = z.object({ token: z.string().uuid() });
export const registerInvitationSchema = acceptInvitationSchema.extend({
	email: inviteMemberSchema.shape.email,
	name: z
		.string()
		.trim()
		.min(1, "Enter a name.")
		.max(120, {
			error: (issue) => `Use ${issue.maximum} characters or fewer.`,
		}),
	password: passwordSchema,
});
export const memberSchema = z.object({
	userId: z.string(),
	name: z.string(),
	email: z.string(),
	role: memberRoleSchema,
});
export const membersResponseSchema = z.object({
	members: z.array(memberSchema),
});
// Organization IDs are UUIDs; Better Auth user IDs are bounded opaque strings.
export const memberTargetSchema = z.object({
	organizationId: resourceIdSchema,
	userId: z.string().min(1).max(128),
});
export const changeMemberSchema = z.object({ role: assignableRoleSchema });
export const acknowledgementSchema = z.object({ ok: z.literal(true) });
export type Organization = z.infer<typeof organizationSchema>;
