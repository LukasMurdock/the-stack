import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { organizationQuery } from "../../../features/organizations/queries";
import { ScrollTabs } from "../../../components/ScrollTabs";
import { tabActiveProps, tabLinkClass } from "../../../components/nav-items";
import { organizationCopy as copy } from "../../../features/organizations/copy";
import { backLinkClass, RecordHeader } from "../../../ui/RecordHeader";

export const Route = createFileRoute(
	"/_authenticated/organizations/$organizationId"
)({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			organizationQuery(context.userId, params.organizationId)
		),
	component: OrganizationLayout,
});
// On this screen the user is here to see which organization this is and
// move between its parts.
function OrganizationLayout() {
	const { userId } = Route.useRouteContext();
	const { organizationId } = Route.useParams();
	const { organization } = useSuspenseQuery(
		organizationQuery(userId, organizationId)
	).data;
	return (
		<div className="space-y-6">
			<div className="space-y-3">
				<RecordHeader
					back={
						<Link to="/organizations" className={backLinkClass}>
							<ArrowLeft aria-hidden className="size-4" />
							{copy.allOrganizations}
						</Link>
					}
					title={organization.name}
					facts={copy.yourAccess(organization.role)}
				/>
				<ScrollTabs label={copy.tabs} className="border-b text-sm">
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
						{copy.members}
					</Link>
				</ScrollTabs>
			</div>
			{/* Drafts, pagination and mutation feedback belong to this organization. */}
			<Outlet key={organizationId} />
		</div>
	);
}
