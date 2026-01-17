import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { nameQueryOptions } from "../queries/nameQuery";
import { apiClient } from "../lib/apiClient";
import { getTurretContext } from "../lib/turretContext";
import { reportError } from "../lib/error-tracker";

const Route = createFileRoute("/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(nameQueryOptions),
	component: HomePage,
});

function HomePage() {
	const nameQuery = useSuspenseQuery(nameQueryOptions);
	const [count, setCount] = useState(0);
	const [turretActive, setTurretActive] = useState(false);

	useEffect(() => {
		const update = () => setTurretActive(Boolean(getTurretContext()));
		update();
		const id = window.setInterval(update, 500);
		return () => window.clearInterval(id);
	}, []);

	function requireTurret(): boolean {
		return Boolean(getTurretContext());
	}

	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					React SPA
				</h1>
				<p className="text-sm text-muted-foreground">
					TanStack Router (file-based) + TanStack Query
				</p>
			</div>

			<div className="grid gap-3 sm:grid-cols-2">
				<div className="rounded-lg border bg-card p-4">
					<div className="text-sm text-muted-foreground">
						GET /api
					</div>
					<div className="mt-1 text-lg font-semibold">
						{nameQuery.data.name}
					</div>
				</div>
				<div className="rounded-lg border bg-card p-4">
					<div className="text-sm text-muted-foreground">Next</div>
					<div className="mt-1 text-lg font-semibold">
						<Link className="underline" to="/status">
							Status page
						</Link>
					</div>
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="text-sm text-muted-foreground">Homepage state</div>
				<div className="mt-2 flex flex-wrap items-center gap-3">
					<Button type="button" onClick={() => setCount((c) => c + 1)}>
						Clicked {count} times
					</Button>
					<div className="text-sm text-muted-foreground">
						Count: <span className="font-medium text-foreground">{count}</span>
					</div>
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4">
				<div className="flex flex-wrap items-center justify-between gap-3">
					<div>
						<div className="text-sm font-medium">Error reporting test</div>
						<div className="text-sm text-muted-foreground">
							Turret capture: {turretActive ? "active" : "inactive"}
						</div>
					</div>
					<div className="text-sm text-muted-foreground">
						{turretActive
							? "Events should appear in the session"
							: "Log in to start a session"}
					</div>
				</div>

				<div className="mt-3 flex flex-wrap gap-2">
					<Button
						type="button"
						disabled={!turretActive}
						onClick={() => {
							// Sends via turretReportSessionError if capture is active.
							reportError(new Error("Intentional UI test error"), {
								source: "window",
								extra: { kind: "manual" },
							});
						}}
					>
						Report UI error
					</Button>

					<Button
						type="button"
						disabled={!turretActive}
						onClick={() => {
							// Intentionally trigger an unhandled promise rejection.
							void Promise.reject(new Error("Intentional unhandled rejection"));
						}}
					>
						Unhandled rejection
					</Button>

					<Button
						type="button"
						disabled={!turretActive}
						onClick={async () => {
							if (!requireTurret()) return;
							// Worker throws an exception -> should be attributed to this session.
							await apiClient.throw.$get();
						}}
					>
						API throw
					</Button>

					<Button
						type="button"
						disabled={!turretActive}
						onClick={async () => {
							if (!requireTurret()) return;
							// Worker returns 500 -> should be attributed to this session.
							await apiClient.fail.$get();
						}}
					>
						API 500
					</Button>
				</div>
			</div>
		</section>
	);
}

export { Route };
