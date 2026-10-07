import { bodyLimit } from "hono/body-limit";
import type { Context, Env, MiddlewareHandler } from "hono";
import type { Hook } from "@hono/zod-openapi";
import type { Bindings } from "../../../index";
import { createAuth } from "../../../auth";
import { makeCoreDb } from "../../../../bindings/d1/core/db";
import {
	productErrorSchema,
	productErrors,
	type ProductErrorCode,
} from "../../../../contracts/operation";
import {
	ProductError,
	invalidInput,
	type OperationContext,
} from "../../../../features/shared/context";
import { requiredSameOrigin } from "./request-security";

export type OperationEnv = {
	Bindings: Bindings;
	Variables: { operation: OperationContext };
};

export const requireUser: MiddlewareHandler<OperationEnv> = async (c, next) => {
	c.header("Cache-Control", "no-store");
	if (
		!["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
		requiredSameOrigin(c.env.APP_URL, c.req.raw)
	) {
		throw new ProductError(
			"forbidden",
			"Use the application origin for this request."
		);
	}
	const session = await createAuth(c.env, c.executionCtx).api.getSession({
		headers: c.req.raw.headers,
	});
	if (!session?.user)
		throw new ProductError("unauthorized", "Sign in to continue.");
	c.set("operation", {
		db: makeCoreDb(c.env.CORE_DB),
		actor: {
			userId: session.user.id,
		},
	});
	await next();
};

export function validationHook(
	result: Parameters<Hook<unknown, Env, string, Response | undefined>>[0]
) {
	if (!result.success) throw invalidInput(result.error);
}

export function operationErrorHandler<E extends Env>(
	error: Error,
	c: Context<E>
) {
	if (!(error instanceof ProductError)) throw error;
	return c.json(
		{
			error: {
				code: error.code,
				message: error.message,
				...(error.fields ? { fields: error.fields } : {}),
			},
		},
		productErrors[error.code].status
	);
}

type ErrorResponses = {
	[
		Definition in (typeof productErrors)[ProductErrorCode] as Definition["status"]
	]: {
		description: Definition["description"];
		content: { "application/json": { schema: typeof productErrorSchema } };
	};
};
// SAFETY: every definition supplies its own status key and the same response schema.
export const errorResponses = Object.fromEntries(
	Object.values(productErrors).map(({ status, description }) => [
		status,
		{
			description,
			content: { "application/json": { schema: productErrorSchema } },
		},
	])
) as ErrorResponses;

const REQUEST_BODY_BYTES_MAX = 16_384;
export const limitBody = bodyLimit({
	maxSize: REQUEST_BODY_BYTES_MAX,
	onError: () => {
		throw new ProductError(
			"request_too_large",
			"Request body is too large."
		);
	},
});
