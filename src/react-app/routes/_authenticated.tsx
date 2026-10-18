import { createFileRoute } from "@tanstack/react-router";
import { AuthenticatedOutlet } from "../features/auth/AuthenticatedOutlet";
import { requireUser } from "../auth";
export const Route = createFileRoute("/_authenticated")({
	beforeLoad: requireUser,
	component: AuthenticatedLayout,
});
function AuthenticatedLayout() {
	const { userId } = Route.useRouteContext();
	// The root draws the app header around this.
	return <AuthenticatedOutlet userId={userId} />;
}
