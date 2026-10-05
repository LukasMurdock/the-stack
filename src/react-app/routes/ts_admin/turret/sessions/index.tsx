import { parseReplaySearch } from "../../../../features/turret/session/replaySearch";
import { createFileRoute, redirect } from "@tanstack/react-router";

import { requireTurretAdmin } from "../../../../lib/requireTurretAdmin";

const Route = createFileRoute("/ts_admin/turret/sessions/")({
	validateSearch: parseReplaySearch,
	beforeLoad: async (ctx) => {
		await requireTurretAdmin(ctx);
		throw redirect({
			to: "/ts_admin/turret/replay-sessions",
			search: ctx.search,
		});
	},
});

export { Route };
