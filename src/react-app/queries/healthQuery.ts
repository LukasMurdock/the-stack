import type { InferResponseType } from "hono/client";
import { queryOptions } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../api";

type HealthResponse = InferResponseType<typeof apiClient.health.$get, 200>;

const healthQueryOptions = queryOptions({
	queryKey: ["api", "health"],
	queryFn: async (): Promise<HealthResponse> => {
		const res = await apiClient.health.$get();
		return jsonOrThrow(res);
	},
});

export { healthQueryOptions };
export type { HealthResponse };
