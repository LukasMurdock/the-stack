import { turretFeedbackBodySchema } from "../../../contracts/turret";
import type { z } from "zod";
import { getTurretContext } from "./context";
import { turretSubmitFeedback, type TurretFeedbackKind } from "./ingest";

type SubmitFeedbackOptions = Omit<
	z.input<typeof turretFeedbackBodySchema>,
	"ts" | "url"
>;

async function submitUserFeedback(
	options: SubmitFeedbackOptions
): Promise<void> {
	const turret = getTurretContext();
	if (!turret) {
		throw new Error("A Turret session is not active");
	}

	const payload = turretFeedbackBodySchema.safeParse({
		...options,
		ts: turret.lastRrwebTsMs ?? Date.now(),
		url: window.location.href,
	});
	if (!payload.success)
		throw new Error(
			payload.error.issues[0]?.message ?? "Invalid feedback."
		);

	await turretSubmitFeedback({
		sessionId: turret.sessionId,
		uploadToken: turret.uploadToken,
		payload: payload.data,
	});
}

export { submitUserFeedback };
export type { TurretFeedbackKind };
