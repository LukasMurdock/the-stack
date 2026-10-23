import { can, canManageMember } from "@/features/organizations/policy";
import {
	changeMemberSchema,
	type memberSchema,
} from "@/contracts/organizations";
import type { z } from "zod";
import { createFileRoute } from "@tanstack/react-router";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import {
	membersQuery,
	organizationQuery,
	changeMemberMutation,
	removeMemberMutation,
} from "../../../../features/organizations/queries";
import {
	organizationCopy as copy,
	roleLabels,
} from "../../../../features/organizations/copy";
import { Invitations } from "../../../../features/organizations/Invitations";
import { MutationFeedback } from "../../../../forms/feedback";
import { OverflowMenu } from "../../../../ui/OverflowMenu";
import type { OverflowItem } from "../../../../ui/overflowItems";
import { Pagination } from "../../../../ui/Pagination";
import { StatusPill } from "../../../../ui/StatusPill";
import { Unit, unitRowStaticClass } from "../../../../ui/Unit";
import { rowsState } from "../../../../ui/unitState";

export const Route = createFileRoute(
	"/_authenticated/organizations/$organizationId/members"
)({
	loader: ({ context, params }) =>
		context.queryClient.ensureQueryData(
			membersQuery(context.userId, params.organizationId)
		),
	component: MembersPage,
});

type Member = z.infer<typeof memberSchema>;

// On this screen the user is here to see who belongs to the organization;
// owners also invite people and change their access.
function MembersPage() {
	const { userId } = Route.useRouteContext();
	const { organizationId } = Route.useParams();
	const [offset, setOffset] = useState(0);
	const { members, page } = useSuspenseQuery(
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
	const handlers = {
		pending: change.isPending || remove.isPending,
		onRole: (member: Member, role: AssignableRole) => {
			remove.reset();
			change.mutate({ userId: member.userId, role });
		},
		onRemove: (member: Member) => {
			if (!window.confirm(copy.confirmRemove(member.name))) return;
			change.reset();
			remove.mutate(member.userId);
		},
	};

	return (
		<div className="space-y-8">
			<div className="space-y-3">
				<Unit
					title={copy.members}
					tabPanel
					meta={
						page.total > 1
							? copy.memberCount(page.total)
							: undefined
					}
					state={rowsState(members.length, copy.noMembers)}
				>
					<ul className="-mx-3">
						{members.map((member) => (
							<MemberRow
								key={member.userId}
								member={member}
								actions={
									canManageMember(
										organization.role,
										member.role
									)
										? memberActions(member, handlers)
										: null
								}
							/>
						))}
					</ul>
				</Unit>
				<MutationFeedback error={change.error ?? remove.error} />
				<Pagination page={page} onPage={setOffset} />
			</div>
			{can(organization.role, "manage") && (
				<Invitations userId={userId} organizationId={organizationId} />
			)}
		</div>
	);
}

type AssignableRole = z.infer<typeof changeMemberSchema>["role"];

// Access changes are rare, so they sit in each row's ⋯ menu.
function memberActions(
	member: Member,
	handlers: {
		pending: boolean;
		onRole: (member: Member, role: AssignableRole) => void;
		onRemove: (member: Member) => void;
	}
): OverflowItem[] {
	return [
		...changeMemberSchema.shape.role.options
			.filter((role) => role !== member.role)
			.map((role) => ({
				label: copy.makeRole(role),
				disabled: handlers.pending,
				onSelect: () => handlers.onRole(member, role),
			})),
		"separator",
		{
			label: copy.remove,
			destructive: true,
			disabled: handlers.pending,
			onSelect: () => handlers.onRemove(member),
		},
	];
}

function MemberRow({
	member,
	actions,
}: {
	member: Member;
	actions: OverflowItem[] | null;
}) {
	return (
		<li className={unitRowStaticClass}>
			<span className="min-w-0 flex-1 space-y-0.5">
				<span className="block truncate font-semibold">
					{member.name}
				</span>
				<span className="block text-sm break-all text-muted-foreground">
					{member.email}
				</span>
			</span>
			<StatusPill tone="neutral">{roleLabels[member.role]}</StatusPill>
			{actions && (
				<OverflowMenu
					label={copy.actionsFor(member.name)}
					items={actions}
				/>
			)}
		</li>
	);
}
