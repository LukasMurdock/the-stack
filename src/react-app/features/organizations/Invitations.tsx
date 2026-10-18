import { invitationLink } from "./invitationToken";
import {
	inviteMemberSchema,
	type invitationsResponseSchema,
} from "../../../contracts/organizations";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	invitationsQuery,
	inviteMemberMutation,
	revokeInvitationMutation,
} from "./queries";
import { organizationCopy as copy, roleLabels } from "./copy";
import { MutationFeedback } from "../../forms/feedback";
import { Pagination } from "../../ui/Pagination";
import { StatusPill } from "../../ui/StatusPill";
import { Unit, unitRowStaticClass } from "../../ui/Unit";
import { queryState } from "../../ui/unitState";

type InviteFields = z.input<typeof inviteMemberSchema>;
type Invitation = z.infer<
	typeof invitationsResponseSchema
>["invitations"][number];

// Invite someone by email, share the link, and see who hasn't joined yet.
export function Invitations({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId: string;
}) {
	const [offset, setOffset] = useState(0);
	const pending = useQuery(invitationsQuery(userId, organizationId, offset));
	const invitations = pending.data?.invitations ?? [];
	const queryClient = useQueryClient();
	const invite = useMutation(
		inviteMemberMutation(queryClient, userId, organizationId)
	);
	const revoke = useMutation(
		revokeInvitationMutation(queryClient, userId, organizationId)
	);

	return (
		<>
			<Unit title={copy.invite} meta={copy.inviteMeta}>
				<InviteForm
					pending={invite.isPending}
					error={invite.error}
					onInvite={(fields, reset) =>
						invite.mutate(fields, {
							onSuccess: () => {
								reset();
								setOffset(0);
							},
						})
					}
				/>
				{invite.data && (
					<InvitationLink
						token={invite.data.invitation.token}
						expiresAtMs={invite.data.invitation.expiresAt}
					/>
				)}
			</Unit>
			<Unit
				title={copy.pendingInvitations}
				state={queryState(
					pending,
					invitations.length,
					copy.noInvitations
				)}
			>
				<ul className="-mx-3">
					{invitations.map((invitation) => (
						<InvitationRow
							key={invitation.id}
							invitation={invitation}
							revoking={revoke.isPending}
							onRevoke={() =>
								revoke.mutate(invitation.id, {
									onSuccess: () => invite.reset(),
								})
							}
						/>
					))}
				</ul>
				<MutationFeedback error={revoke.error} />
			</Unit>
			{/* Shown whenever off the first page, so a stale page can be left. */}
			<Pagination page={pending.data?.page} onPage={setOffset} />
		</>
	);
}

function InviteForm({
	pending,
	error,
	onInvite,
}: {
	pending: boolean;
	error: unknown;
	onInvite: (fields: InviteFields, reset: () => void) => void;
}) {
	const form = useRef<HTMLFormElement>(null);
	return (
		<form
			ref={form}
			className="max-w-lg space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				const fields = new FormData(event.currentTarget);
				const role = inviteMemberSchema.shape.role.safeParse(
					fields.get("role")
				);
				if (!role.success) return;
				onInvite(
					{
						email: String(fields.get("email") ?? ""),
						role: role.data,
					},
					() => form.current?.reset()
				);
			}}
		>
			<fieldset disabled={pending} className="space-y-4">
				<Field>
					<FieldLabel htmlFor="invite-email">
						{copy.emailAddress}
					</FieldLabel>
					<Input
						id="invite-email"
						type="email"
						name="email"
						required
						className="h-11"
						placeholder="name@example.com"
						maxLength={
							inviteMemberSchema.shape.email.maxLength ??
							undefined
						}
					/>
				</Field>
				<RoleField />
				<Button type="submit" size="lg">
					{copy.createInvitation}
				</Button>
			</fieldset>
			<MutationFeedback error={error} />
		</form>
	);
}

function RoleField() {
	return (
		<Field>
			<FieldLabel htmlFor="invite-role">{copy.access}</FieldLabel>
			<select
				id="invite-role"
				defaultValue="viewer"
				name="role"
				className="block h-11 w-full rounded-lg border bg-background px-3 text-sm"
			>
				{inviteMemberSchema.shape.role.options.map((role) => (
					<option key={role} value={role}>
						{roleLabels[role]}
					</option>
				))}
			</select>
		</Field>
	);
}

// The link to send; the server decides when it expires.
function InvitationLink({
	token,
	expiresAtMs,
}: {
	token: string;
	expiresAtMs: number;
}) {
	return (
		<div className="max-w-lg space-y-2 rounded-2xl border bg-card p-4">
			<label htmlFor="invitation-link" className="text-sm font-medium">
				{copy.invitationLink}
			</label>
			<Input
				id="invitation-link"
				data-rrweb-mask
				readOnly
				className="h-11"
				value={invitationLink(window.location.origin, token)}
				onFocus={(event) => event.target.select()}
			/>
			<p className="text-sm text-muted-foreground">
				{copy.expires(expiresAtMs)}
			</p>
		</div>
	);
}

function InvitationRow({
	invitation,
	revoking,
	onRevoke,
}: {
	invitation: Invitation;
	revoking: boolean;
	onRevoke: () => void;
}) {
	return (
		<li className={unitRowStaticClass}>
			<span className="min-w-0 flex-1 space-y-0.5">
				<span className="flex flex-wrap items-center gap-2">
					<span className="font-semibold break-all">
						{invitation.email}
					</span>
					<StatusPill tone="neutral">
						{roleLabels[invitation.role]}
					</StatusPill>
				</span>
				<span className="block text-sm text-muted-foreground">
					{copy.expires(invitation.expiresAt)}
				</span>
			</span>
			<Button variant="ghost" disabled={revoking} onClick={onRevoke}>
				{copy.revoke}
			</Button>
		</li>
	);
}
