import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { EMAIL_DEPENDENT_FEATURES } from "../../../contracts/email-delivery";
import { adminEmailDeliverySchema } from "../../../contracts/email-send-outcome";
import { readLastSend } from "../../email/send-outcome";
import {
	errorResponses,
	operationErrorHandler,
	requireAdmin,
	validationHook,
	type OperationEnv,
} from "./_shared/operation-http";

const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);

// Under /internal/ so the OpenAPI document hides it from non-administrators.
// Unlike /api/readiness it includes the sanitized provider message.
const getEmailDelivery = createRoute({
	method: "get",
	path: "/internal/email-delivery",
	middleware: [requireAdmin] as const,
	responses: {
		200: {
			description: "The last provider send and what email enables",
			content: {
				"application/json": { schema: adminEmailDeliverySchema },
			},
		},
		...errorResponses,
	},
});

export const routes = app.openapi(getEmailDelivery, async (c) => {
	const lastSend = await readLastSend(c.env.CORE_KV);
	return c.json({ lastSend, disabled: [...EMAIL_DEPENDENT_FEATURES] }, 200);
});
