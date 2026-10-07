import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { organizationQuery } from "../../../features/organizations/queries";

export const Route = createFileRoute(
	"/_authenticated/organizations/$organizationId"
)({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			organizationQuery(context.userId, params.organizationId)
		),
	component: OrganizationLayout,
});
function OrganizationLayout() {
	const { userId } = Route.useRouteContext();
	const { organizationId } = Route.useParams();
	const { organization } = useSuspenseQuery(
		organizationQuery(userId, organizationId)
	).data;
	return (
		<div className="space-y-6">
			<div className="space-y-3">
				<Link
					to="/organizations"
					className="text-sm underline underline-offset-4"
				>
					All organizations
				</Link>
				<div className="flex flex-wrap items-center justify-between gap-3">
					<p className="text-lg font-semibold">{organization.name}</p>
					<span className="text-sm capitalize text-muted-foreground">
						{organization.role}
					</span>
				</div>
				<nav
					aria-label="Organization"
					className="flex gap-5 border-b pb-3 text-sm"
				>
					<Link
						to="/organizations/$organizationId/projects"
						params={{ organizationId }}
						activeProps={{ className: "font-semibold underline" }}
					>
						Projects
					</Link>
					<Link
						to="/organizations/$organizationId/members"
						params={{ organizationId }}
						activeProps={{ className: "font-semibold underline" }}
					>
						Members
					</Link>
				</nav>
			</div>
			{/* Drafts, pagination and mutation feedback belong to this organization. */}
			<Outlet key={organizationId} />
		</div>
	);
}
