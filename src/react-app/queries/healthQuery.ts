import { queryOptions } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../lib/apiClient";

type HealthResponse = {
	ok: boolean;
};

const healthQueryOptions = queryOptions({
	queryKey: ["api", "health"],
	queryFn: async (): Promise<HealthResponse> => {
		const res = await apiClient.health.$get();
		return jsonOrThrow<HealthResponse>(res);
	},
});

export { healthQueryOptions };
export type { HealthResponse };
