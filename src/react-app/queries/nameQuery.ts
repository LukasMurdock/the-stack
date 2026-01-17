import { queryOptions } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../lib/apiClient";

type NameResponse = {
	name: string;
};

const nameQueryOptions = queryOptions({
	queryKey: ["api", "name"],
	queryFn: async (): Promise<NameResponse> => {
		const res = await apiClient.index.$get();
		return jsonOrThrow<NameResponse>(res);
	},
});

export { nameQueryOptions };
export type { NameResponse };
