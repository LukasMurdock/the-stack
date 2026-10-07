import { useMemo, useRef } from "react";
import type { TurretWorkflow } from "../../../contracts/turret-outcomes";
import { ApiError } from "../../api";
import { getTurretContext } from "./context";
import { turretRecordOutcome } from "./ingest";

// A failure as a short code: the API error code, the HTTP status, or the kind
// of client failure. Never the message, which can contain user content.
export function outcomeFailureReason(error: unknown): string {
	const reason =
		error instanceof ApiError
			? (error.code ?? `http_${error.status}`)
			: error instanceof TypeError
				? "network"
				: "error";
	return (
		reason
			.toLowerCase()
			.replace(/[^a-z0-9_.-]/g, "_")
			.slice(0, 64) || "error"
	);
}

function send(
	workflow: TurretWorkflow,
	attemptId: string,
	event: "started" | "failed" | "succeeded",
	reason?: string
) {
	const turret = getTurretContext();
	if (!turret) return;
	// Outcome telemetry is best effort and never interrupts the workflow.
	void turretRecordOutcome({
		sessionId: turret.sessionId,
		uploadToken: turret.uploadToken,
		payload: { attemptId, workflow, event, ts: Date.now(), reason },
	}).catch(() => {});
}

// Measures attempts at one workflow from a component. `start` begins an
// attempt (repeated calls continue it); failures keep it open; success ends it,
// so the next `start` begins a new attempt. Attempts that never succeed are
// reported as failed or abandoned once idle.
export function useWorkflowOutcome(workflow: TurretWorkflow) {
	const attempt = useRef<string | null>(null);
	return useMemo(() => {
		function current() {
			if (!attempt.current) {
				attempt.current = crypto.randomUUID();
				send(workflow, attempt.current, "started");
			}
			return attempt.current;
		}
		return {
			start() {
				current();
			},
			failed(error: unknown) {
				send(
					workflow,
					current(),
					"failed",
					outcomeFailureReason(error)
				);
			},
			succeeded() {
				send(workflow, current(), "succeeded");
				attempt.current = null;
			},
		};
	}, [workflow]);
}
