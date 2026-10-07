import { createFileRoute, redirect } from "@tanstack/react-router";
// Preserve old links through the canonical recovery screen.
export const Route = createFileRoute("/_public/reset-password/$token")({
	beforeLoad: ({ params }) => {
		throw redirect({
			to: "/reset-password",
			search: { token: params.token },
			replace: true,
		});
	},
});
