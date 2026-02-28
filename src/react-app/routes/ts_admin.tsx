import { Link, Outlet, createFileRoute } from "@tanstack/react-router";

import { requireCoreAdmin } from "../lib/requireCoreAdmin";

const Route = createFileRoute("/ts_admin")({
	beforeLoad: requireCoreAdmin,
	component: TsAdminLayout,
});

function TsAdminLayout() {
	return (
		<div className="min-h-dvh">
			<header className="border-b bg-card">
				<div className="mx-auto flex max-w-7xl items-center justify-between gap-3 px-4 py-4">
					<div className="flex items-center gap-3">
						<div className="text-lg font-semibold tracking-tight">
							Admin
						</div>
						<div className="text-sm text-muted-foreground">
							/ts_admin
						</div>
					</div>
					<nav className="flex items-center gap-3 text-sm">
						<Link
							to="/ts_admin"
							activeOptions={{ exact: true }}
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Overview
						</Link>
						<Link
							to="/ts_admin/users"
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Users
						</Link>
						<Link
							to="/ts_admin/turret"
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Turret
						</Link>
						<a
							className="underline"
							href="/app"
							title="Back to public app"
						>
							Exit
						</a>
					</nav>
				</div>
			</header>

			<div className="mx-auto max-w-7xl px-4 py-6">
				<Outlet />
			</div>
		</div>
	);
}

export { Route };
