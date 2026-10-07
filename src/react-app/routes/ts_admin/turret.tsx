import { createFileRoute, Outlet } from "@tanstack/react-router";
import { turretHealthQueryOptions } from "../../features/turret/queries";

export const Route = createFileRoute("/ts_admin/turret")({
	beforeLoad: async ({ context }) => {
		await context.queryClient.ensureQueryData(turretHealthQueryOptions);
	},
	component: Outlet,
});
