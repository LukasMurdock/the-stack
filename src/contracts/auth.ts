import { z } from "zod";

export const headerSessionSchema = z
	.object({
		user: z
			.object({ name: z.string().nullish(), email: z.string().nullish() })
			.optional(),
	})
	.nullable();

export const authPolicyResponseSchema = z.object({
	auth: z
		.object({
			signupMode: z.enum(["invite_only", "open"]).optional(),
			selfSignUpEnabled: z.boolean().optional(),
		})
		.optional(),
});
