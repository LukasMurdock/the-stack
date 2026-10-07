import { replaySearchSchema } from "../../../../features/turret/session/replaySearch";
import { createFileRoute, redirect } from "@tanstack/react-router";

const Route = createFileRoute("/ts_admin/turret/sessions/")({
	validateSearch: replaySearchSchema,
	beforeLoad: async (ctx) => {
		throw redirect({
			to: "/ts_admin/turret/replay-sessions",
			search: ctx.search,
		});
	},
});

export { Route };
