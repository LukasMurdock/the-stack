import { z } from "zod";

export const headerSessionSchema = z
	.object({
		user: z
			.object({ name: z.string().nullish(), email: z.string().nullish() })
			.optional(),
	})
	.nullable();

export const passwordSchema = z
	.string()
	.min(8, { error: (issue) => `Use at least ${issue.minimum} characters.` })
	.max(128, {
		error: (issue) => `Use ${issue.maximum} characters or fewer.`,
	});
