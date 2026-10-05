import { createFileRoute, redirect } from "@tanstack/react-router";

import { requireTurretAdmin } from "../../../../lib/requireTurretAdmin";

const Route = createFileRoute("/ts_admin/turret/sessions/$sessionId")({
	beforeLoad: async (ctx) => {
		await requireTurretAdmin(ctx);
		throw redirect({
			to: "/ts_admin/turret/replay-sessions/$sessionId",
			params: ctx.params,
			search: true,
		});
	},
});

export { Route };
