import React from "react";
import { authClient } from "../lib/authClient";
import { createTurretCapture } from "../lib/turretCapture";
import {
	CatchBoundary,
	ErrorComponent,
	Link,
	Outlet,
	createRootRouteWithContext,
	useRouter,
	useRouterState,
} from "@tanstack/react-router";
import type { ErrorComponentProps } from "@tanstack/react-router";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import { useQueryErrorResetBoundary } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { reportError } from "../lib/error-tracker";

type RouterContext = {
	queryClient: QueryClient;
};

const Route = createRootRouteWithContext<RouterContext>()({
	component: RootComponent,
	errorComponent: RootErrorComponent,
	notFoundComponent: RootNotFoundComponent,
	pendingComponent: RootPendingComponent,
});

function RootComponent() {
	const location = useRouterState({
		select: (s) => s.location,
	});

	const sessionQuery = authClient.useSession();
	const turretCaptureRef = React.useRef<ReturnType<typeof createTurretCapture> | null>(null);

	React.useEffect(() => {
		const user = sessionQuery.data?.user;
		if (user && !turretCaptureRef.current) {
			turretCaptureRef.current = createTurretCapture();
		}
		if (!user && turretCaptureRef.current) {
			void turretCaptureRef.current.stop();
			turretCaptureRef.current = null;
		}
	}, [sessionQuery.data?.user]);

	return (
		<div className="min-h-dvh bg-background text-foreground">
			<header className="border-b">
				<div className="mx-auto flex max-w-5xl items-center justify-between gap-3 px-4 py-4">
					<div className="text-lg font-semibold tracking-tight">
						the-stack
					</div>
					<nav className="flex items-center gap-4 text-sm">
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
							to="/status"
							activeProps={{
								className: "font-semibold underline",
							}}
						>
							Status
						</Link>
						<Link
							to="/login"
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
				<CatchBoundary
					getResetKey={() => location.href}
					errorComponent={RootSubtreeError}
					onCatch={(error, errorInfo) => {
						reportError(error, {
							source: "router",
							extra: {
								href: location.href,
								componentStack: errorInfo.componentStack,
							},
						});

						if (import.meta.env.DEV) {
							console.error(error);
							console.error(errorInfo);
						}
					}}
				>
					<Outlet />
				</CatchBoundary>
			</main>

			{import.meta.env.DEV ? (
				<>
					<ReactQueryDevtools buttonPosition="top-right" />
					<TanStackRouterDevtools position="bottom-right" />
				</>
			) : null}
		</div>
	);
}

function RootPendingComponent() {
	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<div className="h-7 w-40 animate-pulse rounded bg-muted" />
				<div className="h-4 w-80 max-w-full animate-pulse rounded bg-muted" />
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="h-24 animate-pulse rounded-lg border bg-card" />
				<div className="h-24 animate-pulse rounded-lg border bg-card" />
			</div>
		</section>
	);
}

function RootNotFoundComponent() {
	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					Page not found
				</h1>
				<p className="text-sm text-muted-foreground">
					That route doesn't exist in this app.
				</p>
			</div>
			<div className="rounded-lg border bg-card p-4 text-sm">
				<div className="font-medium">Try one of these:</div>
				<div className="mt-2 flex flex-wrap gap-3">
					<Link className="underline" to="/">
						Home
					</Link>
					<Link className="underline" to="/status">
						Status
					</Link>
				</div>
			</div>
		</section>
	);
}

function RootSubtreeError({ error }: ErrorComponentProps) {
	const router = useRouter();
	const { reset } = useQueryErrorResetBoundary();

	React.useEffect(() => {
		reset();
	}, [reset]);

	return (
		<div className="rounded-lg border bg-card p-4">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div>
					<div className="text-sm font-medium">This section crashed</div>
					<div className="text-sm text-muted-foreground">
						Try retrying or navigating away.
					</div>
				</div>
				<button
					className="rounded-md border px-3 py-1.5 text-sm"
					onClick={() => router.invalidate()}
					type="button"
				>
					Retry
				</button>
			</div>

			{import.meta.env.DEV ? (
				<div className="mt-3 text-sm">
					<ErrorComponent error={error} />
				</div>
			) : null}
		</div>
	);
}

function RootErrorComponent({ error }: ErrorComponentProps) {
	const router = useRouter();
	const { reset } = useQueryErrorResetBoundary();

	React.useEffect(() => {
		reset();
	}, [reset]);

	const location = useRouterState({
		select: (s) => s.location,
	});

	React.useEffect(() => {
		reportError(error, {
			source: "router",
			extra: {
				kind: "route-error",
				href: location.href,
			},
		});
	}, [error, location.href]);

	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					Something went wrong
				</h1>
				<p className="text-sm text-muted-foreground">
					An error occurred while loading <code>{location.href}</code>
					.
				</p>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex flex-wrap items-center gap-3">
					<button
						className="rounded-md border px-3 py-1.5 text-sm"
						onClick={() => router.invalidate()}
						type="button"
					>
						Retry
					</button>
					<Link className="text-sm underline" to="/">
						Go home
					</Link>
				</div>

				{import.meta.env.DEV ? (
					<div className="mt-3 text-sm">
						<ErrorComponent error={error} />
					</div>
				) : null}
			</div>
		</section>
	);
}

export { Route };
