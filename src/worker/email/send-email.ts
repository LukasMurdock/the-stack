import { Resend } from "resend";
import { z } from "zod";
import { log } from "evlog";
import { recordEmailLogOnlyEvent } from "../observability/evlog";
import {
	traceOperation,
	type ObservabilityContext,
} from "../observability/tracing";

export type EmailTransport = "cloudflare" | "resend" | "log";
export type EmailEnvironment = {
	APP_ENV?: string;
	EMAIL_TRANSPORT?: string;
	EMAIL?: Pick<SendEmail, "send">;
	EMAIL_FROM: string;
	EMAIL_FROM_NAME?: string;
	RESEND_API_KEY?: string;
	CF_VERSION_METADATA?: { id: string };
};
export type EmailType = "reset-password" | "verify-email" | "generic";
export type EmailResult =
	| { transport: "log" }
	| { transport: "cloudflare" | "resend"; messageId: string };

export function isLocalEmailEnvironment(env: EmailEnvironment): boolean {
	return ["local", "dev", "development", "test"].includes(env.APP_ENV ?? "");
}

function configurationError(message: string): Error {
	return Object.assign(new Error(message), { code: "E_EMAIL_CONFIGURATION" });
}

export function resolveEmailTransport(env: EmailEnvironment): EmailTransport {
	const transport =
		env.EMAIL_TRANSPORT ??
		(isLocalEmailEnvironment(env) ? "log" : "cloudflare");
	if (
		transport !== "cloudflare" &&
		transport !== "resend" &&
		transport !== "log"
	)
		throw configurationError(
			"EMAIL_TRANSPORT must be cloudflare, resend, or log"
		);
	if (transport === "log" && !isLocalEmailEnvironment(env))
		throw configurationError(
			"Log-only email is limited to local/dev/test environments"
		);
	return transport;
}

// Support existing single-mailbox display names while new projects use separate
// EMAIL_FROM / EMAIL_FROM_NAME settings. This deliberately isn't an RFC parser.
function sender(env: EmailEnvironment): EmailAddress {
	const display = env.EMAIL_FROM.trim().match(/^([^<>]*)<([^<>]+)>$/);
	const email = (display?.[2] ?? env.EMAIL_FROM).trim();
	const name = env.EMAIL_FROM_NAME ?? display?.[1]?.trim() ?? "";
	if (!z.email().safeParse(email).success || /[\r\n<>]/.test(name))
		throw configurationError(
			"EMAIL_FROM must contain one valid sender mailbox"
		);
	return { email, name };
}

export function emailErrorCode(error: unknown): string | undefined {
	if (
		error &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string"
	)
		return error.code;
	return undefined;
}

export async function sendEmail(args: {
	env: EmailEnvironment;
	ctx?: ObservabilityContext;
	requestId?: string;
	type?: EmailType;
	to: string;
	subject: string;
	text: string;
	html: string;
}): Promise<EmailResult> {
	const {
		env,
		ctx,
		requestId,
		type = "generic",
		to,
		subject,
		html,
		text,
	} = args;
	const transport = resolveEmailTransport(env);
	if (transport === "log") {
		recordEmailLogOnlyEvent({ type, to, from: env.EMAIL_FROM, subject });
		return { transport };
	}
	return traceOperation(
		ctx,
		"email.send",
		{
			"email.type": type,
			"email.provider": transport,
			"request.id": requestId,
			"app.env": env.APP_ENV,
			"app.version": env.CF_VERSION_METADATA?.id,
		},
		async (span) => {
			try {
				const from = sender(env);
				let messageId: string;
				if (transport === "cloudflare") {
					if (!env.EMAIL)
						throw configurationError(
							"Cloudflare email requires the EMAIL binding"
						);
					const result = await env.EMAIL.send({
						from,
						to,
						subject,
						html,
						text,
					});
					messageId = result.messageId;
				} else {
					if (!env.RESEND_API_KEY?.trim())
						throw configurationError(
							"Resend email requires RESEND_API_KEY"
						);
					const result = await new Resend(
						env.RESEND_API_KEY
					).emails.send({
						from: from.name
							? `${JSON.stringify(from.name)} <${from.email}>`
							: from.email,
						to,
						subject,
						html,
						text,
					});
					if (result.error)
						throw Object.assign(new Error(result.error.message), {
							name: result.error.name,
							code: result.error.name,
						});
					messageId = result.data?.id ?? "";
				}
				if (!messageId)
					throw configurationError(
						"Email provider returned no message ID"
					);
				span?.setAttributes({ "email.message_id": messageId });
				// Accepted does not mean delivered. Never log bodies or auth URLs.
				log.info({
					action: "email.accepted",
					requestId,
					app: {
						env: env.APP_ENV,
						version: env.CF_VERSION_METADATA?.id,
					},
					email: { type, provider: transport, messageId },
				});
				return { transport, messageId };
			} catch (error) {
				span?.setAttributes({
					"email.error_code": emailErrorCode(error),
				});
				throw error;
			}
		}
	);
}
