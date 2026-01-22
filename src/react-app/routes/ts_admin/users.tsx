import { Outlet, createFileRoute } from "@tanstack/react-router";

const Route = createFileRoute("/ts_admin/users")({
	component: TsAdminUsersLayout,
});

function TsAdminUsersLayout() {
	return <Outlet />;
}

export { Route };
