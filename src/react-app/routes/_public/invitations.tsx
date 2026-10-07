import { createFileRoute } from "@tanstack/react-router";
import {
	captureInvitationLink,
	invitationToken,
} from "../../features/organizations/invitationToken";
import { InvitationPage } from "../../features/organizations/InvitationPage";

export const Route = createFileRoute("/_public/invitations")({
	beforeLoad: () => {
		captureInvitationLink();
		return { token: invitationToken() ?? "" };
	},
	component: InvitationEntry,
});
function InvitationEntry() {
	const { token } = Route.useRouteContext();
	return <InvitationPage key={token} token={token} />;
}
