import { z } from "zod";

export const resourceIdSchema = z.string().uuid();
export const productErrors = {
	unauthorized: { status: 401, description: "Sign in required" },
	forbidden: { status: 403, description: "Permission denied" },
	not_found: { status: 404, description: "Resource not found" },
	invalid_input: { status: 400, description: "Invalid input" },
	request_too_large: { status: 413, description: "Request body too large" },
} as const;
export type ProductErrorCode = keyof typeof productErrors;
// SAFETY: Object.keys returns exactly the string keys of this closed declaration.
const errorCodes = Object.keys(productErrors) as ProductErrorCode[];
export const productErrorSchema = z.object({
	error: z.object({
		code: z.enum(errorCodes),
		message: z.string(),
		fields: z.record(z.string(), z.string()).optional(),
	}),
});
