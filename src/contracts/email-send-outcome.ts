import { z } from "zod";
import { EMAIL_DEPENDENT_FEATURES } from "./email-delivery";

// The outcome of the last real provider send (Cloudflare or Resend, never
// log-only), kept in CORE_KV under one key so it survives isolates. Readiness
// and the admin banner read it: configuration can look right while every send
// fails (a sender domain not onboarded for the transport), and nobody reads
// `email.send_failed` logs.
export const EMAIL_LAST_SEND_KEY = "email:last-send";
// Provider messages are free text; cap what is stored and shown.
export const EMAIL_ERROR_MESSAGE_LENGTH_MAX = 300;
export const EMAIL_ERROR_CODE_LENGTH_MAX = 64;

export const emailSendOutcomeSchema = z.object({
	outcome: z.enum(["accepted", "failed"]),
	// Failed: when the latest failure happened. Accepted: when sends started
	// succeeding (later successes do not rewrite the record).
	atMs: z.number().int().nonnegative(),
	type: z.enum(["reset-password", "verify-email", "generic"]),
	provider: z.enum(["cloudflare", "resend"]),
	code: z.string().max(EMAIL_ERROR_CODE_LENGTH_MAX).nullable(),
	// Sanitized: no addresses or URLs. Never a recipient, body or auth link.
	message: z.string().max(EMAIL_ERROR_MESSAGE_LENGTH_MAX).nullable(),
});
export type EmailSendOutcome = z.infer<typeof emailSendOutcomeSchema>;

// What unauthenticated /api/readiness shows: no provider message.
export const publicLastSendSchema = emailSendOutcomeSchema.pick({
	outcome: true,
	atMs: true,
	code: true,
});

// GET /api/internal/email-delivery, administrators only.
export const adminEmailDeliverySchema = z.object({
	lastSend: emailSendOutcomeSchema.nullable(),
	disabled: z.array(z.enum(EMAIL_DEPENDENT_FEATURES)),
});

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]*/gi;
const ADDRESS_PATTERN = /[^\s'"<>()[\]@]+@[^\s'"<>()[\]@]+/g;
// Longer provider text is cut before scanning it.
const PROVIDER_MESSAGE_SCAN_LENGTH_MAX = 4_096;

function truncate(text: string, lengthMax: number): string {
	if (text.length <= lengthMax) return text;
	return `${text.slice(0, lengthMax - 1)}…`;
}

// C0 controls and DEL become spaces: the admin UI shows the text verbatim.
function withoutControls(text: string): string {
	let result = "";
	for (const character of text) {
		const code = character.charCodeAt(0);
		result += code < 0x20 || code === 0x7f ? " " : character;
	}
	return result;
}

// URLs first: a URL can contain an `@`.
export function sanitizeProviderMessage(message: string): string {
	const cleaned = withoutControls(
		message.slice(0, PROVIDER_MESSAGE_SCAN_LENGTH_MAX)
	)
		.replace(URL_PATTERN, "[url]")
		.replace(ADDRESS_PATTERN, "[address]")
		.replace(/\s+/g, " ")
		.trim();
	return truncate(cleaned, EMAIL_ERROR_MESSAGE_LENGTH_MAX);
}

export function boundedErrorCode(code: string | undefined): string | null {
	if (code === undefined) return null;
	const cleaned = sanitizeProviderMessage(code);
	if (cleaned.length === 0) return null;
	return truncate(cleaned, EMAIL_ERROR_CODE_LENGTH_MAX);
}
