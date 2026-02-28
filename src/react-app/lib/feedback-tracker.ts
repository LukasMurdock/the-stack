import { getTurretContext } from "./turretContext";
import {
	turretSubmitFeedback,
	type TurretFeedbackKind,
} from "./turretIngestApi";

type SubmitFeedbackOptions = {
	kind: TurretFeedbackKind;
	message: string;
	contact?: string;
	extra?: Record<string, unknown>;
};

async function submitUserFeedback(
	options: SubmitFeedbackOptions
): Promise<void> {
	const turret = getTurretContext();
	if (!turret) {
		throw new Error("Turret capture is not active");
	}

	const message = options.message.trim();
	if (!message) throw new Error("Message is required");

	const ts = turret.lastRrwebTsMs ?? Date.now();

	await turretSubmitFeedback({
		sessionId: turret.sessionId,
		uploadToken: turret.uploadToken,
		payload: {
			ts,
			kind: options.kind,
			message,
			url: window.location.href,
			contact: options.contact?.trim() || undefined,
			extra: options.extra,
		},
	});
}

export { submitUserFeedback };
export type { TurretFeedbackKind };
