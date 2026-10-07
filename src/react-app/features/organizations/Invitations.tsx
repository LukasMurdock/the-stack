import { invitationLink } from "./invitationToken";
import { inviteMemberSchema } from "../../../contracts/organizations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	invitationsQuery,
	inviteMemberMutation,
	revokeInvitationMutation,
} from "./queries";
import { Pagination } from "./Pagination";
import { MutationFeedback } from "../../forms/feedback";
export function Invitations({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId: string;
}) {
	const [offset, setOffset] = useState(0);
	const pending = useQuery(invitationsQuery(userId, organizationId, offset));
	const form = useRef<HTMLFormElement>(null);
	const queryClient = useQueryClient();
	const invite = useMutation(
		inviteMemberMutation(queryClient, userId, organizationId)
	);
	const revoke = useMutation(
		revokeInvitationMutation(queryClient, userId, organizationId)
	);

	return (
		<section className="space-y-4">
			<h2 className="text-lg font-medium">Invite a member</h2>
			<p className="text-sm">
				Share the link with this email address. They can sign in or
				create an account, then verify their email to join.
			</p>
			<form
				ref={form}
				className="max-w-lg space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					const fields = new FormData(event.currentTarget);
					const role = inviteMemberSchema.shape.role.safeParse(
						fields.get("role")
					);
					if (!role.success) return;
					invite.mutate(
						{
							email: String(fields.get("email") ?? ""),
							role: role.data,
						},
						{
							onSuccess: () => {
								form.current?.reset();
								setOffset(0);
							},
						}
					);
				}}
			>
				<fieldset disabled={invite.isPending} className="space-y-3">
					<label htmlFor="invite-email">Email address</label>
					<Input
						id="invite-email"
						type="email"
						name="email"
						required
						maxLength={
							inviteMemberSchema.shape.email.maxLength ??
							undefined
						}
					/>
					<label htmlFor="invite-role">Access</label>
					<select
						id="invite-role"
						defaultValue="viewer"
						name="role"
						className="ml-3 rounded border p-2"
					>
						{inviteMemberSchema.shape.role.options.map((role) => (
							<option key={role} value={role}>
								{role.charAt(0).toUpperCase() + role.slice(1)}
							</option>
						))}
					</select>
					<Button type="submit">Create invitation</Button>
				</fieldset>
				<MutationFeedback error={invite.error} />
			</form>
			{invite.data && (
				<div className="space-y-2">
					<p className="text-sm">
						Expires{" "}
						{new Date(
							invite.data.invitation.expiresAt
						).toLocaleString()}
						.
					</p>
					<label htmlFor="invitation-link">Invitation link</label>
					<Input
						id="invitation-link"
						data-rrweb-mask
						readOnly
						value={invitationLink(
							window.location.origin,
							invite.data.invitation.token
						)}
						onFocus={(event) => event.target.select()}
					/>
				</div>
			)}
			<h3 className="font-medium">Pending invitations</h3>
			<MutationFeedback error={pending.error ?? revoke.error} />
			{pending.data && (
				<>
					<ul className="divide-y rounded border">
						{pending.data.invitations.map((invitation) => (
							<li
								key={invitation.id}
								className="flex flex-wrap justify-between gap-3 p-3"
							>
								<span className="break-all">
									{invitation.email} · {invitation.role}
								</span>
								<Button
									variant="outline"
									disabled={revoke.isPending}
									onClick={() =>
										revoke.mutate(invitation.id, {
											onSuccess: () => invite.reset(),
										})
									}
								>
									Revoke
								</Button>
							</li>
						))}
					</ul>
					<Pagination
						offset={offset}
						count={pending.data.invitations.length}
						onPage={setOffset}
					/>
				</>
			)}
		</section>
	);
}
