import { z } from "zod";
import { adminAccountRoles } from "../features/auth/policy";
import { registerInvitationSchema } from "./organizations";

// The server generates every starting password: an administrator cannot pick
// a weak one, and the browser never sends one. 24 characters from a
// 64-symbol alphabet is 144 bits, well inside passwordSchema's 8..128 bounds.
export const STARTING_PASSWORD_LENGTH = 24;

export const accountRoleSchema = z.enum(["user", ...adminAccountRoles]);

// "verified" lets the person accept invitations without a verification email,
// which a deployment without an email provider cannot send.
export const emailVerificationSchema = z.enum(["verified", "unverified"]);

// Strict: a `password`, `data` or `banned` field is rejected instead of being
// silently dropped, so no client can believe it chose them.
export const createUserSchema = z.strictObject({
	name: registerInvitationSchema.shape.name,
	email: registerInvitationSchema.shape.email,
	role: accountRoleSchema,
	emailVerification: emailVerificationSchema,
});

export const createdUserResponseSchema = z.object({
	user: z.object({
		id: z.string(),
		name: z.string(),
		email: z.string(),
		role: accountRoleSchema,
		emailVerification: emailVerificationSchema,
	}),
	// Returned once, in this response only. It is never stored or logged.
	startingPassword: z.string().length(STARTING_PASSWORD_LENGTH),
});

export type CreateUserInput = z.infer<typeof createUserSchema>;

// Better Auth user ids, or ids an import kept from another system.
const USER_ID_LENGTH_MAX = 128;
export const userTargetSchema = z.object({
	userId: z.string().min(1).max(USER_ID_LENGTH_MAX),
});

// POST /api/internal/users/{userId}/sign-in-link. Administrators already see
// every address, so the response names where the link went.
export const signInLinkResponseSchema = z.object({ sentTo: z.string() });
