import {
	REPLAY_CHUNK_BYTES_MAX,
	jsonBytes,
} from "../../../contracts/turret-ingest";
import type { InferRequestType } from "hono/client";
import type { z } from "zod";
import { apiClient, jsonOrThrow } from "../../api";
import { turretInitResponseSchema } from "../../../contracts/turret";

const replay = apiClient.turret["replay-session"];
const session = replay[":id"];
export type TurretInitResponse = z.infer<typeof turretInitResponseSchema>;
export type TurretFeedbackKind = InferRequestType<
	typeof session.feedback.$post
>["json"]["kind"];

// Recorder states are narrower than the server's diagnostic reason string.
export type TurretBlockedReason =
	| "rrweb_blocked_by_client"
	| "rrweb_initialization_failed"
	| "replay_serialization_failed"
	| "replay_payload_limit"
	| "replay_upload_failed";

type UploadSession = { sessionId: string; uploadToken: string };

export async function turretInitReplaySession(input: {
	journeyId: string;
	initialUrl: string;
	signal?: AbortSignal;
}): Promise<TurretInitResponse> {
	return jsonOrThrow(
		await replay.init.$post(
			{
				json: {
					journey_id: input.journeyId,
					initial_url: input.initialUrl,
				},
			},
			{ init: { signal: input.signal } }
		),
		turretInitResponseSchema
	);
}

export async function turretUploadChunk(
	input: UploadSession & {
		seq: number;
		events: unknown[];
		tsStart: number;
		tsEnd: number;
		signal?: AbortSignal;
	}
): Promise<void> {
	const payload = {
		seq: input.seq,
		events: input.events,
		ts_start: input.tsStart,
		ts_end: input.tsEnd,
	};
	if (jsonBytes(payload) > REPLAY_CHUNK_BYTES_MAX)
		throw new Error("Replay chunk exceeds the upload byte limit.");
	await jsonOrThrow(
		await session.chunk.$post(
			{
				param: { id: encodeURIComponent(input.sessionId) },
				header: { authorization: `Bearer ${input.uploadToken}` },
				json: payload,
			},
			{ init: { signal: input.signal } }
		)
	);
}

export async function turretMarkCaptureBlocked(
	input: UploadSession & {
		reason: TurretBlockedReason;
		message?: string;
	}
): Promise<void> {
	await jsonOrThrow(
		await session.blocked.$post({
			param: { id: encodeURIComponent(input.sessionId) },
			header: { authorization: `Bearer ${input.uploadToken}` },
			json: { reason: input.reason, message: input.message },
		})
	);
}

export async function turretReportReplaySessionError(
	input: UploadSession & {
		payload: InferRequestType<typeof session.error.$post>["json"];
		signal?: AbortSignal;
	}
): Promise<void> {
	await jsonOrThrow(
		await session.error.$post(
			{
				param: { id: encodeURIComponent(input.sessionId) },
				header: { authorization: `Bearer ${input.uploadToken}` },
				json: input.payload,
			},
			{ init: { signal: input.signal } }
		)
	);
}

export async function turretSubmitFeedback(
	input: UploadSession & {
		payload: InferRequestType<typeof session.feedback.$post>["json"];
		signal?: AbortSignal;
	}
): Promise<void> {
	await jsonOrThrow(
		await session.feedback.$post(
			{
				param: { id: encodeURIComponent(input.sessionId) },
				header: { authorization: `Bearer ${input.uploadToken}` },
				json: input.payload,
			},
			{ init: { signal: input.signal } }
		)
	);
}
