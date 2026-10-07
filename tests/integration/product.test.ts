import assert from "node:assert/strict";
import test from "node:test";
import { productFixture } from "../helpers/product";
import { ProductError } from "../../src/features/shared/context";
import * as organizations from "../../src/features/organizations/operations";
import * as members from "../../src/features/organizations/members";
import * as invitations from "../../src/features/organizations/invitations";
import * as projects from "../../src/features/projects/operations";
const failure = (code: string) => (error: unknown) =>
	error instanceof ProductError && error.code === code;
async function fixture() {
	const f = productFixture();
	const organization = await organizations.createOrganization(
		f.actor("owner"),
		{ name: "Studio" }
	);
	for (const role of ["editor", "viewer"])
		f.sqlite
			.prepare("insert into memberships values (?, ?, ?)")
			.run(organization.id, role, role);
	return { ...f, organizationId: organization.id };
}
test("organization ownership is atomic and tenant reads are scoped", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	assert.equal(
		(
			await organizations.getOrganization(
				f.actor("owner"),
				f.organizationId
			)
		).role,
		"owner"
	);
	assert.deepEqual(
		await organizations.listOrganizations(f.actor("outsider")),
		[]
	);
	await assert.rejects(
		() =>
			organizations.getOrganization(
				f.actor("outsider"),
				f.organizationId
			),
		failure("not_found")
	);
	f.sqlite.exec(
		"create trigger reject_owner before insert on memberships begin select raise(abort, 'member unavailable'); end;"
	);
	await assert.rejects(
		() =>
			organizations.createOrganization(f.actor("owner"), { name: "New" }),
		/member unavailable/
	);
	assert.equal(
		(await organizations.listOrganizations(f.actor("owner"))).length,
		1
	);
});
test("example writes require editor access and lists isolate tenants", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	const project = await projects.createProject(
		f.actor("editor"),
		f.organizationId,
		{ name: " Launch ", description: " Plan " }
	);
	assert.equal(project.name, "Launch");
	assert.equal(project.description, "Plan");
	assert.equal(
		(await projects.listProjects(f.actor("viewer"), f.organizationId))
			.length,
		1
	);
	await assert.rejects(
		() =>
			projects.createProject(f.actor("viewer"), f.organizationId, {
				name: "No",
				description: "",
			}),
		failure("forbidden")
	);
	await assert.rejects(
		() => projects.listProjects(f.actor("outsider"), f.organizationId),
		failure("not_found")
	);
	const other = await organizations.createOrganization(f.actor("owner"), {
		name: "Other",
	});
	assert.deepEqual(
		await projects.listProjects(f.actor("owner"), other.id),
		[]
	);
});
test("member policy protects the owner and applies role changes", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	await assert.rejects(
		() => members.removeMember(f.actor("owner"), f.organizationId, "owner"),
		failure("not_found")
	);
	await assert.rejects(
		() =>
			members.changeMember(f.actor("owner"), f.organizationId, "owner", {
				role: "viewer",
			}),
		failure("not_found")
	);
	await assert.rejects(
		() =>
			members.removeMember(f.actor("editor"), f.organizationId, "viewer"),
		failure("forbidden")
	);
	await members.changeMember(f.actor("owner"), f.organizationId, "editor", {
		role: "viewer",
	});
	await assert.rejects(
		() =>
			projects.createProject(f.actor("editor"), f.organizationId, {
				name: "No",
				description: "",
			}),
		failure("forbidden")
	);
});
test("invitations require matching verified email; successful retries do not restore removed membership", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	const invite = await invitations.inviteMember(
		f.actor("owner"),
		f.organizationId,
		{ email: " OUTSIDER@example.test ", role: "editor" }
	);
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("viewer"), {
				token: invite.token,
			}),
		failure("not_found")
	);
	f.sqlite
		.prepare(
			"update auth_user set email_verified = 0 where id = 'outsider'"
		)
		.run();
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			}),
		failure("not_found")
	);
	f.sqlite
		.prepare(
			"update auth_user set email_verified = 1, email = 'Outsider@Example.Test' where id = 'outsider'"
		)
		.run();
	const accepted = await Promise.all(
		Array.from({ length: 4 }, () =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			})
		)
	);
	assert.ok(accepted.every((org) => org.role === "editor"));
	await members.changeMember(f.actor("owner"), f.organizationId, "outsider", {
		role: "viewer",
	});
	assert.equal(
		(
			await invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			})
		).role,
		"viewer"
	);
	await members.removeMember(f.actor("owner"), f.organizationId, "outsider");
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			}),
		failure("not_found")
	);
});
test("expired/revoked invitations fail and membership failure rolls back consumption", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	const invite = await invitations.inviteMember(
		f.actor("owner"),
		f.organizationId,
		{ email: "outsider@example.test", role: "viewer" }
	);
	f.sqlite.exec(
		"create trigger reject_member before insert on memberships begin select raise(abort, 'member unavailable'); end;"
	);
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			}),
		/member unavailable/
	);
	f.sqlite.exec("drop trigger reject_member");
	await invitations.revokeInvitation(
		f.actor("owner"),
		f.organizationId,
		invite.id
	);
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			}),
		failure("not_found")
	);
	const expired = await invitations.inviteMember(
		f.actor("owner"),
		f.organizationId,
		{ email: "outsider@example.test", role: "viewer" }
	);
	f.sqlite
		.prepare("update invitations set expires_at = 0 where id = ?")
		.run(expired.id);
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: expired.token,
			}),
		failure("not_found")
	);
	assert.deepEqual(
		await invitations.listInvitations(f.actor("owner"), f.organizationId),
		[]
	);
});
test("lists paginate without losing records and operation inputs are validated", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	for (let index = 0; index < 51; index++)
		await projects.createProject(f.actor("owner"), f.organizationId, {
			name: `Project ${index}`,
			description: "",
		});
	const first = await projects.listProjects(
		f.actor("viewer"),
		f.organizationId
	);
	const second = await projects.listProjects(
		f.actor("viewer"),
		f.organizationId,
		{ offset: 50 }
	);
	assert.equal(first.length, 50);
	assert.equal(second.length, 1);
	assert.equal(
		new Set([...first, ...second].map((project) => project.id)).size,
		51
	);
	await assert.rejects(
		() =>
			projects.createProject(f.actor("owner"), f.organizationId, {
				name: " ",
				description: "",
			}),
		failure("invalid_input")
	);
	await assert.rejects(
		() => organizations.listOrganizations(f.actor("owner"), { offset: -1 }),
		failure("invalid_input")
	);
});

test("membership revoked between the access check and insert prevents the write", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	// Intercept the write preparation, after requireMembership has completed.
	const prepare = f.binding.prepare;
	f.binding.prepare = (query) => {
		if (query.startsWith('insert into "projects"'))
			f.sqlite
				.prepare("delete from memberships where user_id = 'editor'")
				.run();
		return prepare(query);
	};
	const context = f.actor("editor");

	await assert.rejects(
		() =>
			projects.createProject(context, f.organizationId, {
				name: "Denied",
				description: "",
			}),
		failure("forbidden")
	);
	assert.deepEqual(
		await projects.listProjects(f.actor("owner"), f.organizationId),
		[]
	);
});

test("invitation eligibility agrees at expiry while accepted retries remain independent", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	const invite = await invitations.inviteMember(
		f.actor("owner"),
		f.organizationId,
		{
			email: "outsider@example.test",
			role: "viewer",
		}
	);
	let now = invite.expiresAt - 1;
	t.mock.method(Date, "now", () => now);
	const registration = {
		token: invite.token,
		email: "outsider@example.test",
		name: "Outsider",
		password: "Valid-password-123!",
	};
	assert.equal(
		(
			await invitations.listInvitations(
				f.actor("owner"),
				f.organizationId
			)
		)[0]?.id,
		invite.id
	);
	await invitations.invitationRegistration(f.db, registration);
	now = invite.expiresAt;
	assert.deepEqual(
		await invitations.listInvitations(f.actor("owner"), f.organizationId),
		[]
	);
	await assert.rejects(
		() => invitations.invitationRegistration(f.db, registration),
		failure("not_found")
	);
	await assert.rejects(
		() =>
			invitations.acceptInvitation(f.actor("outsider"), {
				token: invite.token,
			}),
		failure("not_found")
	);
	// Expiry does not prevent the owner from revoking the unconsumed invitation.
	await invitations.revokeInvitation(
		f.actor("owner"),
		f.organizationId,
		invite.id
	);
	const accepted = await invitations.inviteMember(
		f.actor("owner"),
		f.organizationId,
		{
			email: "outsider@example.test",
			role: "viewer",
		}
	);
	await invitations.acceptInvitation(f.actor("outsider"), {
		token: accepted.token,
	});
	assert.deepEqual(
		await invitations.listInvitations(f.actor("owner"), f.organizationId),
		[]
	);
	await assert.rejects(
		() =>
			invitations.invitationRegistration(f.db, {
				...registration,
				token: accepted.token,
			}),
		failure("not_found")
	);
	now = accepted.expiresAt + 1;
	assert.equal(
		(
			await invitations.acceptInvitation(f.actor("outsider"), {
				token: accepted.token,
			})
		).role,
		"viewer"
	);
});

test("member operations validate target IDs and preserve opaque Better Auth IDs", async (t) => {
	const f = await fixture();
	t.after(() => f.sqlite.close());
	for (const userId of ["", "x".repeat(129)]) {
		for (const operation of [
			() =>
				members.changeMember(
					f.actor("owner"),
					f.organizationId,
					userId,
					{ role: "viewer" }
				),
			() =>
				members.removeMember(
					f.actor("owner"),
					f.organizationId,
					userId
				),
		]) {
			await assert.rejects(operation, (error: unknown) => {
				assert.ok(error instanceof ProductError);
				assert.equal(error.code, "invalid_input");
				assert.ok(error.fields?.userId);
				return true;
			});
		}
	}
	const userId = "u".repeat(128);
	f.sqlite
		.prepare(
			"insert into auth_user (id, name, email, email_verified) values (?, 'Member', 'bounded@example.test', 1)"
		)
		.run(userId);
	f.sqlite
		.prepare("insert into memberships values (?, ?, 'editor')")
		.run(f.organizationId, userId);
	await members.changeMember(f.actor("owner"), f.organizationId, userId, {
		role: "viewer",
	});
	assert.equal(
		(await members.listMembers(f.actor("owner"), f.organizationId)).find(
			(member) => member.userId === userId
		)?.role,
		"viewer"
	);
	await members.removeMember(f.actor("owner"), f.organizationId, userId);
	assert.equal(
		(await members.listMembers(f.actor("owner"), f.organizationId)).some(
			(member) => member.userId === userId
		),
		false
	);
});

test("invitation creation rechecks membership removal and role downgrade inside the insert", async (t) => {
	for (const change of [
		"delete from memberships where user_id='owner'",
		"update memberships set role='editor' where user_id='owner'",
	]) {
		const f = await fixture();
		t.after(() => f.sqlite.close());
		const prepare = f.binding.prepare;
		f.binding.prepare = (query) => {
			if (query.startsWith('insert into "invitations"'))
				f.sqlite.exec(change);
			return prepare(query);
		};
		await assert.rejects(
			() =>
				invitations.inviteMember(f.actor("owner"), f.organizationId, {
					email: "outsider@example.test",
					role: "viewer",
				}),
			failure("forbidden")
		);
		assert.equal(
			f.sqlite.prepare("select count(*) from invitations").pluck().get(),
			0
		);
	}
});
