import { z } from "zod";
import type { CoreDb } from "../../bindings/d1/core/db";
import type { ProductErrorCode } from "../../contracts/operation";

export type Actor = { userId: string };
export type OperationContext = { db: CoreDb; actor: Actor };
export class ProductError extends Error {
	constructor(
		public readonly code: ProductErrorCode,
		message: string,
		public readonly fields?: Record<string, string>
	) {
		super(message);
	}
}
export function commandInput<T>(schema: z.ZodType<T>, input: unknown): T {
	const result = schema.safeParse(input);
	if (result.success) return result.data;
	throw invalidInput(result.error);
}

export function invalidInput(error: z.ZodError) {
	const fields: Record<string, string> = {};
	for (const issue of error.issues) {
		const key = issue.path.join(".");
		fields[key] ??= issue.message;
	}
	return new ProductError(
		"invalid_input",
		"Check the submitted values.",
		fields
	);
}
