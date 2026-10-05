import { isRecord } from "../../lib/isRecord";
import { hc } from "hono/client";
import type { ApiType } from "../../worker/api";

import { getTurretContext } from "./turretContext";

const apiClient = hc<ApiType>("/api", {
	headers: (): Record<string, string> => {
		const turret = getTurretContext();
		if (!turret) return {};
		return {
			"x-turret-session-id": turret.sessionId,
			"x-turret-replay-ts": String(turret.lastRrwebTsMs ?? Date.now()),
		};
	},
});

type ApiClient = typeof apiClient;

type ApiErrorPayload = {
	error?: string;
	message?: string;
};

type JsonResponseLike = {
	ok: boolean;
	status: number;
	json(): Promise<unknown>;
};

class ApiError extends Error {
	status: number;
	payload?: unknown;

	constructor(args: { message: string; status: number; payload?: unknown }) {
		super(args.message);
		this.name = "ApiError";
		this.status = args.status;
		this.payload = args.payload;
	}
}

async function tryParseJson(
	res: JsonResponseLike
): Promise<unknown | undefined> {
	try {
		return await res.json();
	} catch {
		return undefined;
	}
}

async function jsonOrThrow<T>(res: JsonResponseLike): Promise<T> {
	if (!res.ok) {
		const payload = await tryParseJson(res);
		const apiPayload = isRecord(payload) ? payload : undefined;

		const message =
			typeof apiPayload?.message === "string"
				? apiPayload.message
				: typeof apiPayload?.error === "string"
					? apiPayload.error
					: `Request failed: ${res.status}`;

		throw new ApiError({ message, status: res.status, payload });
	}

	// SAFETY: callers supply the JSON contract of the owned API route they requested, after the HTTP success check. This transport boundary does not perform runtime validation.
	return res.json() as Promise<T>;
}

export { apiClient, jsonOrThrow, ApiError };
export type { ApiClient, ApiErrorPayload };
