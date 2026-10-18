import { createFileRoute } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { healthQueryOptions } from "../../queries/healthQuery";
import { nameQueryOptions } from "../../queries/nameQuery";
import { LinkRow } from "../../ui/LinkRow";
import { PageHeader } from "../../ui/PageHeader";
import { StatusPill } from "../../ui/StatusPill";
import { Unit, unitRowStaticClass } from "../../ui/Unit";

const Route = createFileRoute("/_public/status")({
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

	const healthy = healthQuery.data.ok;
	return (
		<div className="space-y-8">
			<PageHeader title="Status" />
			<Unit title="API">
				<ul className="-mx-3">
					<li className={unitRowStaticClass}>
						<span className="min-w-0 flex-1 space-y-0.5">
							<span className="block font-medium">
								{nameQuery.data.name}
							</span>
							<span className="block text-sm text-muted-foreground">
								GET /api
							</span>
						</span>
					</li>
					<li className={unitRowStaticClass}>
						<span className="min-w-0 flex-1 space-y-0.5">
							<span className="block font-medium">Health</span>
							<span className="block text-sm text-muted-foreground">
								GET /api/health
							</span>
						</span>
						<StatusPill tone={healthy ? "done" : "stopped"}>
							{healthy ? "Healthy" : "Unhealthy"}
						</StatusPill>
					</li>
				</ul>
			</Unit>
			<Unit title="API docs">
				<ul className="-mx-3">
					<LinkRow
						url="/api/scalar"
						title="Scalar UI"
						detail="Browse and try every endpoint"
					/>
					<LinkRow
						url="/api/doc"
						title="OpenAPI JSON"
						detail="/api/doc"
					/>
				</ul>
			</Unit>
		</div>
	);
}

export { Route };
