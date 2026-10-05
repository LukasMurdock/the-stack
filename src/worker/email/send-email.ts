import { Resend } from "resend";
import { recordEmailLogOnlyEvent } from "../observability/evlog";
import {
	traceOperation,
	type ObservabilityContext,
} from "../observability/tracing";

type SendEmailOptions = {
	ctx?: ObservabilityContext;
	type?: "reset-password" | "verify-email" | "generic";
	resendApiKey: string | undefined;
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
	logOnly?: boolean;
};

export async function sendEmail({
	ctx,
	type = "generic",
	resendApiKey,
	from,
	to,
	subject,
	text,
	html,
	logOnly,
}: SendEmailOptions): Promise<void> {
	const shouldLogOnly = logOnly ?? !resendApiKey;

	if (shouldLogOnly) {
		// Intentionally avoid rendering full HTML here; local dev should be log-only.
		recordEmailLogOnlyEvent({ type, to, from, subject });
		return;
	}

	await traceOperation(
		ctx,
		"email.send",
		{ "email.type": type },
		async () => {
			const resend = new Resend(resendApiKey);
			const result = await resend.emails.send({
				from,
				to,
				subject,
				html,
				text,
			});
			// Resend reports provider failures as data rather than rejected promises.
			if (result.error) {
				const error = new Error(result.error.message);
				error.name = result.error.name;
				throw error;
			}
		}
	);
}
