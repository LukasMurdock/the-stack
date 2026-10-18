import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { organizationQuery } from "../../../features/organizations/queries";
import { ScrollTabs } from "../../../components/ScrollTabs";
import { tabActiveProps, tabLinkClass } from "../../../components/nav-items";

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
						<span className="sr-only">Your role: </span>
						{organization.role}
					</span>
				</div>
				<ScrollTabs label="Organization" className="border-b text-sm">
					{/* example:start */}
					<Link
						to="/organizations/$organizationId/projects"
						params={{ organizationId }}
						className={tabLinkClass}
						activeProps={tabActiveProps}
					>
						Projects
					</Link>
					{/* example:end */}
					<Link
						to="/organizations/$organizationId/members"
						params={{ organizationId }}
						className={tabLinkClass}
						activeProps={tabActiveProps}
					>
						Members
					</Link>
				</ScrollTabs>
			</div>
			{/* Drafts, pagination and mutation feedback belong to this organization. */}
			<Outlet key={organizationId} />
		</div>
	);
}
