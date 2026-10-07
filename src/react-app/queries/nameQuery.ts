import type { InferResponseType } from "hono/client";
import { queryOptions } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../api";

type NameResponse = InferResponseType<typeof apiClient.index.$get, 200>;

const nameQueryOptions = queryOptions({
	queryKey: ["api", "name"],
	queryFn: async (): Promise<NameResponse> => {
		const res = await apiClient.index.$get();
		return jsonOrThrow(res);
	},
});

export { nameQueryOptions };
export type { NameResponse };
