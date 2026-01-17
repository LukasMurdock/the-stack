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

async function tryParseJson(res: Response): Promise<unknown | undefined> {
	try {
		// Clone since the body can only be read once.
		return await res.clone().json();
	} catch {
		return undefined;
	}
}

async function jsonOrThrow<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const payload = await tryParseJson(res);
		const apiPayload = payload as ApiErrorPayload | undefined;

		const message =
			apiPayload?.message ??
			apiPayload?.error ??
			`Request failed: ${res.status}`;

		throw new ApiError({ message, status: res.status, payload });
	}

	return res.json() as Promise<T>;
}

export { apiClient, jsonOrThrow, ApiError };
export type { ApiClient, ApiErrorPayload };
