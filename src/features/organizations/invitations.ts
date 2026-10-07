import { PAGE_SIZE, pageSchema } from "../../contracts/pagination";
import { and, eq, exists, gt, isNull, sql } from "drizzle-orm";
import { resourceIdSchema } from "../../contracts/operation";
import { membershipPredicate, requireMembership } from "./authorization";
import {
	commandInput,
	ProductError,
	type OperationContext,
} from "../shared/context";
import {
	auth_user,
	invitations,
	memberships,
	organizations,
} from "../../bindings/d1/core/schema";
import {
	acceptInvitationSchema,
	inviteMemberSchema,
	registerInvitationSchema,
} from "../../contracts/organizations";
import type { CoreDb } from "../../bindings/d1/core/db";
import { getOrganization } from "./operations";

const INVITATION_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

// Shared eligibility for listing, registration, and first acceptance.
// Acceptance retries and revocation intentionally use different conditions.
function activeInvitationPredicate(now: number) {
	return and(
		isNull(invitations.acceptedAt),
		isNull(invitations.revokedAt),
		gt(invitations.expiresAt, now)
	);
}

export async function listInvitations(
	context: OperationContext,
	organizationId: string,
	input: unknown = {}
) {
	const { offset } = commandInput(pageSchema, input);
	commandInput(resourceIdSchema, organizationId);
	await requireMembership(context, organizationId, "manage");
	return context.db
		.select({
			id: invitations.id,
			email: invitations.email,
			role: invitations.role,
			expiresAt: invitations.expiresAt,
		})
		.from(invitations)
		.where(
			and(
				eq(invitations.organizationId, organizationId),
				activeInvitationPredicate(Date.now()),
				membershipPredicate(context, organizationId, "manage")
			)
		)
		.orderBy(invitations.expiresAt)
		.limit(PAGE_SIZE)
		.offset(offset);
}
async function hashToken(token: string) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(token)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

// Registration proves possession of a live invitation, but does not consume it
// or grant membership. Acceptance still requires ownership of the verified email.
export async function invitationRegistration(db: CoreDb, input: unknown) {
	const command = commandInput(registerInvitationSchema, input);
	const tokenHash = await hashToken(command.token);
	const [invitation] = await db
		.select({ id: invitations.id })
		.from(invitations)
		.where(
			and(
				eq(invitations.tokenHash, tokenHash),
				eq(invitations.email, command.email),
				activeInvitationPredicate(Date.now())
			)
		)
		.limit(1);
	if (!invitation)
		throw new ProductError(
			"not_found",
			"Invitation is expired, revoked, or does not match your email."
		);
	return command;
}
export async function inviteMember(
	context: OperationContext,
	organizationId: string,
	input: unknown
) {
	commandInput(resourceIdSchema, organizationId);
	const command = commandInput(inviteMemberSchema, input);
	await requireMembership(context, organizationId, "manage");
	const id = crypto.randomUUID();
	const token = crypto.randomUUID();
	const tokenHash = await hashToken(token);
	const expiresAt = Date.now() + INVITATION_LIFETIME_MS;
	const rows = await context.db
		.insert(invitations)
		.select(
			context.db
				.select({
					id: sql<string>`${id}`.as("id"),
					organizationId: organizations.id,
					email: sql<string>`${command.email}`.as("email"),
					role: sql<typeof command.role>`${command.role}`.as("role"),
					tokenHash: sql<string>`${tokenHash}`.as("tokenHash"),
					expiresAt: sql<number>`${expiresAt}`.as("expiresAt"),
					acceptedBy: sql<null>`null`.as("acceptedBy"),
					acceptedAt: sql<null>`null`.as("acceptedAt"),
					revokedAt: sql<null>`null`.as("revokedAt"),
					acceptanceKey: sql<null>`null`.as("acceptanceKey"),
				})
				.from(organizations)
				.where(
					and(
						eq(organizations.id, organizationId),
						membershipPredicate(context, organizationId, "manage")
					)
				)
		)
		.returning({ id: invitations.id });
	if (!rows.length)
		throw new ProductError(
			"forbidden",
			"Your access changed. Reload and try again."
		);
	return { id, token, expiresAt };
}
export async function revokeInvitation(
	context: OperationContext,
	organizationId: string,
	invitationId: string
) {
	commandInput(resourceIdSchema, organizationId);
	commandInput(resourceIdSchema, invitationId);
	await requireMembership(context, organizationId, "manage");
	const rows = await context.db
		.update(invitations)
		.set({ revokedAt: Date.now() })
		.where(
			and(
				eq(invitations.organizationId, organizationId),
				eq(invitations.id, invitationId),
				sql`${invitations.acceptedAt} is null`,
				membershipPredicate(context, organizationId, "manage")
			)
		)
		.returning();
	if (!rows.length)
		throw new ProductError("not_found", "Pending invitation not found.");
}
export async function acceptInvitation(
	context: OperationContext,
	input: unknown
) {
	const command = commandInput(acceptInvitationSchema, input);
	const tokenHash = await hashToken(command.token);
	const now = Date.now();
	const acceptanceKey = crypto.randomUUID();
	// Consume the invitation and establish membership together. Replays do not
	// restore a subsequently removed member or overwrite an existing role.
	const [accepted] = await context.db.batch([
		context.db
			.update(invitations)
			.set({
				acceptedBy: context.actor.userId,
				acceptedAt: now,
				acceptanceKey,
			})
			.where(
				and(
					eq(invitations.tokenHash, tokenHash),
					activeInvitationPredicate(now),
					exists(
						context.db
							.select({ id: auth_user.id })
							.from(auth_user)
							.where(
								and(
									eq(auth_user.id, context.actor.userId),
									eq(
										sql`lower(${auth_user.email})`,
										invitations.email
									),
									eq(auth_user.emailVerified, true)
								)
							)
					)
				)
			)
			.returning({ organizationId: invitations.organizationId }),
		context.db
			.insert(memberships)
			.select(
				context.db
					.select({
						organizationId: invitations.organizationId,
						userId: sql<string>`${context.actor.userId}`.as(
							"userId"
						),
						role: invitations.role,
					})
					.from(invitations)
					.where(
						and(
							eq(invitations.tokenHash, tokenHash),
							eq(invitations.acceptedBy, context.actor.userId),
							eq(invitations.acceptanceKey, acceptanceKey)
						)
					)
			)
			.onConflictDoNothing(),
	]);
	if (!accepted[0]) {
		const [previous] = await context.db
			.select({ organizationId: invitations.organizationId })
			.from(invitations)
			.innerJoin(
				memberships,
				and(
					eq(memberships.organizationId, invitations.organizationId),
					eq(memberships.userId, context.actor.userId)
				)
			)
			.where(
				and(
					eq(invitations.tokenHash, tokenHash),
					eq(invitations.acceptedBy, context.actor.userId)
				)
			);
		if (previous) return getOrganization(context, previous.organizationId);
		throw new ProductError(
			"not_found",
			"Invitation is expired, revoked, or does not match your verified email."
		);
	}

	return getOrganization(context, accepted[0].organizationId);
}
