import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { healthQueryOptions } from "../queries/healthQuery";
import { nameQueryOptions } from "../queries/nameQuery";

const Route = createFileRoute("/status")({
	loader: ({ context }) =>
		Promise.all([
			context.queryClient.ensureQueryData(nameQueryOptions),
			context.queryClient.ensureQueryData(healthQueryOptions),
		]),
	component: StatusPage,
});

function StatusPage() {
	const nameQuery = useSuspenseQuery(nameQueryOptions);
	const healthQuery = useSuspenseQuery(healthQueryOptions);

	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">
					Status
				</h1>
				<p className="text-sm text-muted-foreground">
					Example TanStack Query reads against the Hono API.
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
					<div className="text-sm text-muted-foreground">
						GET /api/health
					</div>
					<div className="mt-1 text-lg font-semibold">
						{healthQuery.data.ok ? "ok" : "not ok"}
					</div>
				</div>
			</div>

			<div className="rounded-lg border bg-card p-4 text-sm">
				<div className="font-medium">API docs</div>
				<div className="mt-2 flex flex-wrap gap-3 text-muted-foreground">
					<a
						className="underline"
						href="/api/doc"
						target="_blank"
						rel="noreferrer"
					>
						OpenAPI JSON
					</a>
					<a
						className="underline"
						href="/api/scalar"
						target="_blank"
						rel="noreferrer"
					>
						Scalar UI
					</a>
				</div>
			</div>
		</section>
	);
}

export { Route };
