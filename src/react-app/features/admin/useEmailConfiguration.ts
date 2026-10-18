import { useQuery } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../../api";

// What configuration says email can do (/api/readiness `email`), for the admin
// email notice and the admin actions that send email. Undefined while loading.
export function useEmailConfiguration() {
	const readiness = useQuery({
		queryKey: ["readiness"],
		retry: false,
		queryFn: async () => jsonOrThrow(await apiClient.readiness.$get()),
	});
	return readiness.data?.email;
}
