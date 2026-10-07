import { Link, Outlet } from "@tanstack/react-router";
import { TurretFeedbackWidget } from "../features/turret/FeedbackWidget";
export function AppLayout({ children }: { children?: React.ReactNode }) {
	return (
		<div>
			<header className="border-b">
				<div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-4">
					<div className="text-lg font-semibold tracking-tight">
						the-stack
					</div>
					<nav className="flex flex-wrap items-center gap-4 text-sm">
						<Link
							to="/"
							activeOptions={{ exact: true }}
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Home
						</Link>
						<Link
							to="/organizations"
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Organizations
						</Link>
						<Link
							to="/status"
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Status
						</Link>
						<Link
							to="/login"
							search={{}}
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Login
						</Link>
						<a
							className="underline"
							href="/api/scalar"
							target="_blank"
							rel="noreferrer"
						>
							API Docs
						</a>
					</nav>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-4 py-6">
				{children ?? <Outlet />}
			</main>
			<TurretFeedbackWidget />
		</div>
	);
}
