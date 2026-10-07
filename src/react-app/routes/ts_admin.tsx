import { AuthenticatedOutlet } from "../features/auth/AuthenticatedOutlet";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { ApiError } from "../api";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";

import { authClient, requireUser } from "../auth";

const Route = createFileRoute("/ts_admin")({
	beforeLoad: async (context) => {
		const identity = await requireUser(context);
		const { error } = await authClient.admin.listUsers({
			query: { limit: 1, offset: 0 },
		});
		if (error)
			throw new ApiError({
				status: error.status ?? 500,
				message:
					error.status === 403
						? "Administrator access is required."
						: "Could not check administrator access.",
			});
		return identity;
	},
	component: TsAdminLayout,
	errorComponent: AdminAccessError,
});

function TsAdminLayout() {
	const { userId } = Route.useRouteContext();
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
						<Link
							className="underline"
							to="/"
							title="Back to public app"
						>
							Exit
						</Link>
					</nav>
				</div>
			</header>

			<div className="mx-auto max-w-7xl px-4 py-6">
				<AuthenticatedOutlet userId={userId} />
			</div>
		</div>
	);
}

export { Route };

function AdminAccessError({ error }: ErrorComponentProps) {
	const router = useRouter();
	const denied = error instanceof ApiError && error.status === 403;
	return (
		<section className="space-y-3 p-6">
			<h1 className="text-xl font-semibold">
				{denied
					? "Administrator access is required."
					: "Could not load the administrator area."}
			</h1>
			<Link to="/" className="underline">
				Go home
			</Link>
			{!denied && (
				<button
					type="button"
					onClick={() => router.invalidate()}
					className="ml-4 underline"
				>
					Retry
				</button>
			)}
		</section>
	);
}
