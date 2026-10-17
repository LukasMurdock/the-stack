import {
	EMAIL_LAST_SEND_KEY,
	boundedErrorCode,
	emailSendOutcomeSchema,
	sanitizeProviderMessage,
	type EmailSendOutcome,
} from "../../contracts/email-send-outcome";
import { recordEmailOutcomeStoreFailure } from "../observability/evlog";
import type { EmailType } from "./send-email";

// The subset of KVNamespace this module uses (CORE_KV in the Worker).
export type EmailOutcomeStore = {
	get(key: string): Promise<string | null>;
	put(key: string, value: string): Promise<void>;
};

type ProviderSend = {
	readonly type: EmailType;
	readonly provider: EmailSendOutcome["provider"];
	readonly atMs: number;
};

export function acceptedOutcome(send: ProviderSend): EmailSendOutcome {
	return { outcome: "accepted", ...send, code: null, message: null };
}

export function failedOutcome(
	send: ProviderSend,
	failure: { readonly error: unknown; readonly code: string | undefined }
): EmailSendOutcome {
	const raw =
		failure.error instanceof Error
			? failure.error.message
			: String(failure.error);
	const message = sanitizeProviderMessage(raw);
	return {
		outcome: "failed",
		...send,
		code: boundedErrorCode(failure.code),
		message: message.length > 0 ? message : null,
	};
}

// A record that does not parse (an older shape, a hand edit) reads as none.
export async function readLastSend(
	store: EmailOutcomeStore
): Promise<EmailSendOutcome | null> {
	const raw = await store.get(EMAIL_LAST_SEND_KEY);
	if (raw === null) return null;
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch {
		// Unreadable as JSON: the next send overwrites it.
		return null;
	}
	const parsed = emailSendOutcomeSchema.safeParse(json);
	return parsed.success ? parsed.data : null;
}

// KV allows about one write per second per key. Every failure is written so
// the latest error shows; a success is written only when it changes the
// stored outcome, so steady delivery costs one read per send.
export function needsWrite(
	current: EmailSendOutcome | null,
	next: EmailSendOutcome
): boolean {
	if (next.outcome === "failed") return true;
	return current?.outcome !== "accepted";
}

export async function recordEmailSendOutcome(
	store: EmailOutcomeStore,
	next: EmailSendOutcome
): Promise<"written" | "unchanged"> {
	if (next.outcome === "accepted") {
		const current = await readLastSend(store);
		if (!needsWrite(current, next)) return "unchanged";
	}
	await store.put(EMAIL_LAST_SEND_KEY, JSON.stringify(next));
	return "written";
}

// For the send path: a store failure is logged and never thrown, so it cannot
// break or delay an auth response.
export async function recordEmailSendOutcomeSafely(
	store: EmailOutcomeStore | undefined,
	next: EmailSendOutcome
): Promise<void> {
	// Unit tests that call the sender without CORE_KV; the Worker always binds it.
	if (store === undefined) return;
	try {
		await recordEmailSendOutcome(store, next);
	} catch (error: unknown) {
		recordEmailOutcomeStoreFailure({ outcome: next.outcome, error });
	}
}
