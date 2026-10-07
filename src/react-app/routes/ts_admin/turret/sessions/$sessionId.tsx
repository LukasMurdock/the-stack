import { createFileRoute, redirect } from "@tanstack/react-router";

const Route = createFileRoute("/ts_admin/turret/sessions/$sessionId")({
	beforeLoad: async (ctx) => {
		throw redirect({
			to: "/ts_admin/turret/replay-sessions/$sessionId",
			params: ctx.params,
			search: true,
		});
	},
});

export { Route };
