import * as React from "react";
import { AuthEmail } from "../emails/auth-email";
import { renderEmail } from "../emails/render";
import { recordEmailSendFailure } from "../observability/evlog";
import type { ObservabilityContext } from "../observability/tracing";
import {
	sendEmail,
	resolveEmailTransport,
	isLocalEmailEnvironment,
	emailErrorCode,
	type EmailEnvironment,
	type EmailType,
} from "./send-email";

// Keep auth responses independent of recipient/provider outcomes to preserve
// account enumeration protections. Failures remain visible in logs and spans.
export async function sendAuthEmail(args: {
	env: EmailEnvironment & { PRODUCT_NAME: string };
	ctx?: ObservabilityContext;
	requestId?: string;
	type: Exclude<EmailType, "generic">;
	to: string;
	url: string;
}): Promise<void> {
	const { env, ctx, requestId, type, to, url } = args;
	const operation = (async () => {
		const transport = resolveEmailTransport(env);
		if (transport === "log" && isLocalEmailEnvironment(env))
			console.log("[email:log-only:url]", { type, to, url });
		const rendered = await renderEmail(
			React.createElement(AuthEmail, {
				type,
				productName: env.PRODUCT_NAME,
				url,
			})
		);
		await sendEmail({
			env,
			ctx,
			requestId,
			type,
			to,
			subject:
				type === "reset-password"
					? `Reset your password for ${env.PRODUCT_NAME}`
					: `Verify your email for ${env.PRODUCT_NAME}`,
			...rendered,
		});
	})().catch((error: unknown) => {
		recordEmailSendFailure({
			type,
			error,
			code: emailErrorCode(error),
			provider:
				env.EMAIL_TRANSPORT ??
				(isLocalEmailEnvironment(env) ? "log" : "cloudflare"),
			requestId,
			environment: env.APP_ENV,
			version: env.CF_VERSION_METADATA?.id,
		});
	});
	if (ctx) ctx.waitUntil(operation);
	else await operation;
}
