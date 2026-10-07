import { createFileRoute } from "@tanstack/react-router";
import { projectsQuery } from "../../../../../features/projects/queries";
import { ProjectsPage } from "../../../../../features/projects/ProjectsPage";

export const Route = createFileRoute(
	"/_authenticated/organizations/$organizationId/projects/"
)({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			projectsQuery(context.userId, params.organizationId)
		),
	component: ProjectsRoute,
});
function ProjectsRoute() {
	const { userId } = Route.useRouteContext();
	const { organizationId } = Route.useParams();
	return <ProjectsPage userId={userId} organizationId={organizationId} />;
}
