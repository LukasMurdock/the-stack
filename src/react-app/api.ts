import { z } from "zod";
import { productErrorSchema } from "../contracts/operation";
import { isRecord } from "../lib/isRecord";
import { hc, type ClientResponse } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";
import type { ApiType } from "../worker/api";

let requestHeaders: () => Record<string, string> = () => ({});

// Application startup supplies optional request metadata. Transport has no
// dependency on the feature producing it.
export function setApiRequestHeaders(headers: () => Record<string, string>) {
	requestHeaders = headers;
}
const apiClient = hc<ApiType>("/api", { headers: () => requestHeaders() });

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
	fields?: Record<string, string>;
	code?: string;

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

type SuccessJson<R> =
	R extends ClientResponse<infer T, infer Status, infer Format>
		? Format extends "json"
			? Status extends SuccessStatusCode
				? T
				: never
			: never
		: unknown;

// A decoder must accept the RPC wire payload; its output may intentionally transform it.
function jsonOrThrow<R extends JsonResponseLike, S extends z.ZodType>(
	res: R,
	schema: S &
		(unknown extends SuccessJson<R>
			? unknown
			: NoInfer<SuccessJson<R>> extends z.input<S>
				? unknown
				: never)
): Promise<z.output<S>>;
function jsonOrThrow<R extends JsonResponseLike>(
	res: R
): Promise<SuccessJson<R>>;
async function jsonOrThrow(
	res: JsonResponseLike,
	schema?: z.ZodType
): Promise<unknown> {
	const payload = await tryParseJson(res);
	if (!res.ok) {
		const outcome = productErrorSchema.safeParse(payload);
		const apiPayload = isRecord(payload) ? payload : undefined;
		const message = outcome.success
			? outcome.data.error.message
			: typeof apiPayload?.message === "string"
				? apiPayload.message
				: typeof apiPayload?.error === "string"
					? apiPayload.error
					: `Request failed: ${res.status}`;
		const error = new ApiError({ message, status: res.status, payload });
		if (outcome.success) {
			error.code = outcome.data.error.code;
			error.fields = outcome.data.error.fields;
		}
		throw error;
	}
	if (payload === undefined)
		throw new ApiError({
			message: "The server returned an invalid JSON response.",
			status: res.status,
		});
	if (schema) return schema.parse(payload);
	// RPC supplies the static contract; a schema additionally validates runtime data.
	return payload;
}

export { apiClient, jsonOrThrow, ApiError };
export type { ApiClient, ApiErrorPayload };
