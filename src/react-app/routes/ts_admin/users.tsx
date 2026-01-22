import { Outlet, createFileRoute } from "@tanstack/react-router";

import { requireCoreAdmin } from "../../lib/requireCoreAdmin";

const Route = createFileRoute("/ts_admin/users")({
	beforeLoad: requireCoreAdmin,
	component: TsAdminUsersLayout,
});

function TsAdminUsersLayout() {
	return <Outlet />;
}

export { Route };
