import { useQuery } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../../api";

// Tells an administrator, where they onboard people, that email-based flows
// cannot work here, so they create accounts directly instead of inviting.
export function EmailDeliveryNotice() {
	const readiness = useQuery({
		queryKey: ["readiness"],
		retry: false,
		queryFn: async () => jsonOrThrow(await apiClient.readiness.$get()),
	});
	const email = readiness.data?.email;
	if (email === undefined) return null;
	if (email.delivery === "provider") return null;
	if (email.delivery === "log_only")
		return (
			<p role="note" className="text-sm text-muted-foreground">
				This environment logs email instead of sending it.
			</p>
		);
	return (
		<div role="note" className="rounded-md border p-3 text-sm">
			<p className="font-medium">Email is not configured.</p>
			<p className="text-muted-foreground">
				{email.reason} Until it is, these cannot be sent:{" "}
				{email.disabled.join(", ")}. Use Create user and give people
				their starting password.
			</p>
		</div>
	);
}
