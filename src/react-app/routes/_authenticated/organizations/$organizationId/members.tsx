import { can, canManageMember } from "@/features/organizations/policy";
import { changeMemberSchema } from "@/contracts/organizations";
import { createFileRoute } from "@tanstack/react-router";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	membersQuery,
	organizationQuery,
	changeMemberMutation,
	removeMemberMutation,
} from "../../../../features/organizations/queries";
import { Pagination } from "../../../../features/organizations/Pagination";
import { Invitations } from "../../../../features/organizations/Invitations";
import { MutationFeedback } from "../../../../forms/feedback";
export const Route = createFileRoute(
	"/_authenticated/organizations/$organizationId/members"
)({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			membersQuery(context.userId, params.organizationId)
		),
	component: MembersPage,
});
function MembersPage() {
	const { userId } = Route.useRouteContext();
	const { organizationId } = Route.useParams();
	const [offset, setOffset] = useState(0);
	const { members } = useSuspenseQuery(
		membersQuery(userId, organizationId, offset)
	).data;
	const { organization } = useSuspenseQuery(
		organizationQuery(userId, organizationId)
	).data;
	const queryClient = useQueryClient();
	const change = useMutation(
		changeMemberMutation(queryClient, userId, organizationId)
	);
	const remove = useMutation(
		removeMemberMutation(queryClient, userId, organizationId)
	);
	const isPending = change.isPending || remove.isPending;

	return (
		<section className="space-y-6">
			<h1 className="text-2xl font-semibold">Members</h1>
			<ul className="divide-y rounded border">
				{members.map((member) => (
					<li
						key={member.userId}
						className="flex flex-wrap items-center justify-between gap-3 p-4"
					>
						<div>
							<p className="font-medium">{member.name}</p>
							<p className="break-all text-sm">{member.email}</p>
						</div>
						{canManageMember(organization.role, member.role) ? (
							<div className="flex gap-3">
								<select
									aria-label={`Role for ${member.name}`}
									value={member.role}
									disabled={isPending}
									onChange={(event) => {
										const role =
											changeMemberSchema.shape.role.safeParse(
												event.target.value
											);
										if (role.success) {
											remove.reset();
											change.mutate({
												userId: member.userId,
												role: role.data,
											});
										}
									}}
								>
									{changeMemberSchema.shape.role.options.map(
										(role) => (
											<option key={role} value={role}>
												{role.charAt(0).toUpperCase() +
													role.slice(1)}
											</option>
										)
									)}
								</select>
								<Button
									variant="outline"
									disabled={isPending}
									onClick={() => {
										if (
											window.confirm(
												`Remove ${member.name}?`
											)
										) {
											change.reset();
											remove.mutate(member.userId);
										}
									}}
								>
									Remove
								</Button>
							</div>
						) : (
							<span className="capitalize">{member.role}</span>
						)}
					</li>
				))}
			</ul>
			<MutationFeedback error={change.error ?? remove.error} />
			<Pagination
				offset={offset}
				count={members.length}
				onPage={setOffset}
			/>
			{can(organization.role, "manage") && (
				<Invitations userId={userId} organizationId={organizationId} />
			)}
		</section>
	);
}
