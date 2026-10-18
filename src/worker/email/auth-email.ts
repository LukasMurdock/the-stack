import * as React from "react";
import type { EmailSendOutcome } from "../../contracts/email-send-outcome";
import { AuthEmail } from "../emails/auth-email";
import { authEmailCopy, type AuthEmailType } from "../emails/auth-email-copy";
import { renderEmail } from "../emails/render";
import { recordEmailSendFailure } from "../observability/evlog";
import type { ObservabilityContext } from "../observability/tracing";
import {
	sendEmail,
	resolveEmailTransport,
	isLocalEmailEnvironment,
	emailErrorCode,
	type EmailEnvironment,
	type EmailTransport,
} from "./send-email";
import {
	acceptedOutcome,
	failedOutcome,
	recordEmailSendOutcomeSafely,
	type EmailOutcomeStore,
} from "./send-outcome";

type AuthEmailEnvironment = EmailEnvironment & {
	PRODUCT_NAME: string;
	CORE_KV?: EmailOutcomeStore;
};

type AuthEmailRequest = {
	env: AuthEmailEnvironment;
	ctx?: ObservabilityContext;
	requestId?: string;
	type: AuthEmailType;
	to: string;
	url: string;
};

// Keep auth responses independent of recipient/provider outcomes to preserve
// account enumeration protections. Failures remain visible in logs and spans,
// and provider outcomes in CORE_KV for readiness and the admin banner.
export async function sendAuthEmail(args: AuthEmailRequest): Promise<void> {
	const operation = deliverAuthEmail(args);
	if (args.ctx) args.ctx.waitUntil(operation);
	else await operation;
}

async function deliverAuthEmail(args: AuthEmailRequest): Promise<void> {
	const { env, type, requestId } = args;
	let provider: EmailSendOutcome["provider"] | null = null;
	try {
		const transport = resolveEmailTransport(env);
		if (transport !== "log") provider = transport;
		await composeAndSend(args, transport);
	} catch (error: unknown) {
		const code = emailErrorCode(error);
		recordEmailSendFailure({
			type,
			error,
			code,
			provider:
				env.EMAIL_TRANSPORT ??
				(isLocalEmailEnvironment(env) ? "log" : "cloudflare"),
			requestId,
			environment: env.APP_ENV,
			version: env.CF_VERSION_METADATA?.id,
		});
		// A transport that does not resolve is configuration, which readiness
		// already reports; only provider sends are recorded.
		if (provider !== null)
			await recordEmailSendOutcomeSafely(
				env.CORE_KV,
				failedOutcome(
					{ type, provider, atMs: Date.now() },
					{ error, code }
				)
			);
		return;
	}
	if (provider !== null)
		await recordEmailSendOutcomeSafely(
			env.CORE_KV,
			acceptedOutcome({ type, provider, atMs: Date.now() })
		);
}

async function composeAndSend(
	args: AuthEmailRequest,
	transport: EmailTransport
): Promise<void> {
	const { env, ctx, requestId, type, to, url } = args;
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
		subject: `${authEmailCopy(type, env.PRODUCT_NAME).heading} for ${env.PRODUCT_NAME}`,
		...rendered,
	});
}
