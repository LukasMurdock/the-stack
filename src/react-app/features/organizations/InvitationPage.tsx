import { invitationLink } from "./invitationToken";
import { InvitationRegistration } from "./InvitationRegistration";
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { useWorkflowOutcome } from "../turret/outcomes";
import { Button } from "@/components/ui/button";
import { acceptInvitationMutation } from "./queries";
import { MutationFeedback } from "../../forms/feedback";
import { authClient } from "../../auth";

function AcceptInvitation({
	token,
	user,
}: {
	token: string;
	user: { id: string; email: string; emailVerified: boolean };
}) {
	const userId = user.id;
	const queryClient = useQueryClient();
	const accept = useMutation(
		acceptInvitationMutation(queryClient, userId, token)
	);
	// Arriving with an invitation starts an attempt to accept it.
	const outcome = useWorkflowOutcome("invitation.accept");
	useEffect(() => {
		if (token) outcome.start();
	}, [outcome, token]);
	const verify = useMutation({
		mutationFn: async () => {
			const result = await authClient.sendVerificationEmail({
				email: user.email,
				// Email links may open in another tab, without this tab's storage.
				callbackURL: invitationLink(window.location.origin, token),
			});
			if (result.error)
				throw new Error(
					result.error.message ?? "Could not send verification email."
				);
		},
	});
	return (
		<section className="max-w-lg space-y-4">
			<h1 className="text-2xl font-semibold tracking-tight">
				Join an organization
			</h1>
			{accept.data ? (
				<>
					<p role="status">
						You joined {accept.data.organization.name}.
					</p>
					<Link
						className="underline underline-offset-4"
						to="/organizations/$organizationId/members"
						params={{ organizationId: accept.data.organization.id }}
					>
						Open organization
					</Link>
				</>
			) : (
				<>
					<p className="text-sm text-muted-foreground">
						Accept this invitation using the email address it was
						sent to.
					</p>
					{token ? (
						<Button
							type="button"
							disabled={accept.isPending}
							onClick={() =>
								accept.mutate(undefined, {
									onSuccess: outcome.succeeded,
									onError: outcome.failed,
								})
							}
						>
							Accept invitation
						</Button>
					) : (
						<p>
							Open the invitation link shared by your organization
							owner.
						</p>
					)}
					<MutationFeedback error={accept.error} />
					{!user.emailVerified && (
						<div className="space-y-3">
							<p className="text-sm">
								Verify your email address before accepting.
							</p>
							<Button
								type="button"
								variant="outline"
								disabled={verify.isPending}
								onClick={() => verify.mutate()}
							>
								Send verification email
							</Button>
							<MutationFeedback
								error={verify.error}
								success={
									verify.isSuccess
										? "Verification email sent."
										: undefined
								}
							/>
						</div>
					)}
				</>
			)}
		</section>
	);
}

export function InvitationPage({ token }: { token: string }) {
	const session = authClient.useSession();
	if (session.isPending) return <p>Checking session…</p>;
	if (!session.data?.user)
		return (
			<InvitationRegistration
				token={token}
				onRegistered={() => session.refetch()}
			/>
		);
	return (
		<AcceptInvitation
			key={session.data.user.id}
			token={token}
			user={session.data.user}
		/>
	);
}
