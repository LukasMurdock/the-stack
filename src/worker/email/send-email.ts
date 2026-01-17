import { Resend } from "resend";

type SendEmailOptions = {
	resendApiKey: string | undefined;
	from: string;
	to: string;
	subject: string;
	text: string;
	html: string;
	logOnly?: boolean;
};

export async function sendEmail({
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
		console.log("[email:log-only]", { to, from, subject });
		return;
	}

	const resend = new Resend(resendApiKey);

	await resend.emails.send({
		from,
		to,
		subject,
		html,
		text,
	});
}
