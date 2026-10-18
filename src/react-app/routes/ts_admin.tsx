import { AuthenticatedOutlet } from "../features/auth/AuthenticatedOutlet";
import { EmailFailureBanner } from "../features/admin/EmailFailureBanner";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { ApiError } from "../api";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";

import { ArrowLeft, ShieldCheck } from "lucide-react";
import { AccountMenu } from "../components/AccountMenu";
import { ScrollTabs } from "../components/ScrollTabs";
import { appName, tabActiveProps, tabLinkClass } from "../components/nav-items";
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
	// The admin area has its own header.
	staticData: { appChrome: false },
	component: TsAdminLayout,
	errorComponent: AdminAccessError,
});

// The way back to the app comes first; the developer path stays out of sight.
function TsAdminLayout() {
	const { userId } = Route.useRouteContext();
	const user = authClient.useSession().data?.user;
	return (
		<div className="min-h-dvh">
			<header className="border-b bg-card">
				<div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-2">
					<Link
						to="/"
						className="flex min-h-11 items-center gap-1 text-sm whitespace-nowrap text-muted-foreground hover:text-foreground"
					>
						<ArrowLeft className="size-4" aria-hidden="true" />
						<span className="sm:hidden">App</span>
						<span className="hidden sm:inline">
							Back to {appName}
						</span>
					</Link>
					<div className="mr-auto flex items-center gap-2 pl-2 text-lg font-semibold tracking-tight">
						<ShieldCheck className="size-5" aria-hidden="true" />
						Admin
					</div>
					{user && <AccountMenu user={user} />}
				</div>
				<ScrollTabs
					label="Admin"
					className="mx-auto max-w-7xl px-2 text-sm"
				>
					<Link
						to="/ts_admin"
						activeOptions={{ exact: true }}
						className={tabLinkClass}
						activeProps={tabActiveProps}
					>
						Overview
					</Link>
					<Link
						to="/ts_admin/users"
						className={tabLinkClass}
						activeProps={tabActiveProps}
					>
						Users
					</Link>
					<Link
						to="/ts_admin/turret"
						className={tabLinkClass}
						activeProps={tabActiveProps}
					>
						Turret
					</Link>
				</ScrollTabs>
			</header>

			<div className="mx-auto max-w-7xl px-4 py-6">
				<EmailFailureBanner />
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
