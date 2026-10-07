import { createFileRoute } from "@tanstack/react-router";
import { AuthenticatedOutlet } from "../features/auth/AuthenticatedOutlet";
import { requireUser } from "../auth";
import { AppLayout } from "../components/AppLayout";
export const Route = createFileRoute("/_authenticated")({
	beforeLoad: requireUser,
	component: AuthenticatedLayout,
});
function AuthenticatedLayout() {
	const { userId } = Route.useRouteContext();
	return (
		<AppLayout>
			<AuthenticatedOutlet userId={userId} />
		</AppLayout>
	);
}
