import { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import { PasswordResetPage } from "../../features/auth/PasswordResetPage";
const searchSchema = z.object({
	token: z.string().optional(),
	error: z.string().optional(),
});

export const Route = createFileRoute("/_public/reset-password")({
	validateSearch: (search: Record<string, unknown>) =>
		searchSchema.parse(search),
	component: ResetPasswordRoute,
});
function ResetPasswordRoute() {
	const { token, error } = Route.useSearch();
	return (
		<PasswordResetPage
			key={token ?? error ?? "request"}
			token={token}
			invalidToken={error === "INVALID_TOKEN"}
		/>
	);
}
