import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { migratedSqlite, migrationDirectory } from "../helpers/migrations";
import { organizationFixture } from "../helpers/product";
import { signedInApi } from "../helpers/product-http";
import { readSqlRow } from "../helpers/sqlite-d1";
import { ProductError } from "../../src/features/shared/context";
import * as organizations from "../../src/features/organizations/operations";
import * as members from "../../src/features/organizations/members";
import * as projects from "../../src/features/projects/operations";
import {
	projectResponseSchema,
	projectsResponseSchema,
} from "../../src/features/projects/contracts";
import { organizationResponseSchema } from "../../src/contracts/organizations";
import { productErrorSchema } from "../../src/contracts/operation";

// The removable example's operations. Core organization tests must not
// depend on anything here.
const failure = (code: string) => (error: unknown) =>
	error instanceof ProductError && error.code === code;
test("example writes require editor access and lists isolate tenants", async (t) => {
	const f = await organizationFixture();
	t.after(() => f.sqlite.close());
	const project = await projects.createProject(
		f.actor("editor"),
		f.organizationId,
		{ name: " Launch ", description: " Plan " }
	);
	assert.equal(project.name, "Launch");
	assert.equal(project.description, "Plan");
	assert.equal(
		(await projects.listProjects(f.actor("viewer"), f.organizationId)).rows
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
		(await projects.listProjects(f.actor("owner"), other.id)).rows,
		[]
	);
});
test("lists page in insertion order with totals from the same filters", async (t) => {
	const f = await organizationFixture();
	t.after(() => f.sqlite.close());
	// Every project lands in one millisecond: the list keeps the order of writes.
	const now = Date.now();
	t.mock.method(Date, "now", () => now);
	const created: string[] = [];
	for (let index = 0; index < 51; index++)
		created.push(
			(
				await projects.createProject(
					f.actor("owner"),
					f.organizationId,
					{
						name: `Project ${index}`,
						description: "",
					}
				)
			).id
		);
	const other = await organizations.createOrganization(f.actor("owner"), {
		name: "Other",
	});
	await projects.createProject(f.actor("owner"), other.id, {
		name: "Elsewhere",
		description: "",
	});
	const list = (offset: number) =>
		projects.listProjects(f.actor("viewer"), f.organizationId, { offset });
	const [first, second, past] = [
		await list(0),
		await list(50),
		await list(100),
	];
	assert.deepEqual(
		[first.page, second.page, past.page],
		[
			{ offset: 0, total: 51 },
			{ offset: 50, total: 51 },
			{ offset: 100, total: 51 },
		]
	);
	assert.deepEqual(
		[...first.rows, ...second.rows].map((project) => project.id),
		created.toReversed()
	);
	assert.deepEqual(past.rows, []);
	await assert.rejects(
		() =>
			projects.createProject(f.actor("owner"), f.organizationId, {
				name: " ",
				description: "",
			}),
		failure("invalid_input")
	);
});

test("membership revoked between the access check and insert prevents the write", async (t) => {
	const f = await organizationFixture();
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
		(await projects.listProjects(f.actor("owner"), f.organizationId)).rows,
		[]
	);
});

test("demoted editors lose example writes", async (t) => {
	const f = await organizationFixture();
	t.after(() => f.sqlite.close());
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

// Before the split, 0002 created this table. D1 records migrations by name, so
// a database that applied the old 0002 still runs 0003 and must accept it.
test("the example migration accepts databases where the table already exists", (t) => {
	const sqlite = migratedSqlite("core");
	t.after(() => sqlite.close());
	const indexes = () =>
		readSqlRow(
			sqlite,
			"SELECT count(*) AS n FROM sqlite_master WHERE type='index' AND tbl_name='projects'"
		).n;
	const before = indexes();
	sqlite.exec(
		readFileSync(
			new URL("0003_example-projects.sql", migrationDirectory("core")),
			"utf8"
		)
	);
	assert.equal(indexes(), before);
	assert.equal(
		readSqlRow(
			sqlite,
			"SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='projects'"
		).n,
		1
	);
});

test("example HTTP routes authenticate, validate, limit bodies and page", async (t) => {
	const { f, request } = await signedInApi();
	t.after(() => f.sqlite.close());
	const { organization } = organizationResponseSchema.parse(
		await (
			await request("/organizations", "POST", { name: "Studio" })
		).json()
	);
	const path = `/organizations/${organization.id}/projects`;
	for (const method of ["GET", "POST"])
		assert.equal(
			(await request(path, method, undefined, "")).status,
			401,
			`${method} ${path}`
		);
	const response = await request(path, "POST", {
		name: "Launch",
		description: "",
	});
	assert.equal(response.status, 201, await response.clone().text());
	projectResponseSchema.parse(await response.json());
	const listed = projectsResponseSchema.parse(
		await (await request(path)).json()
	);
	assert.deepEqual(listed.page, { offset: 0, total: 1 });
	const tooLarge = await request(path, "POST", {
		name: "A",
		description: "x".repeat(20_000),
	});
	assert.equal(tooLarge.status, 413);
	assert.equal(
		productErrorSchema.parse(await tooLarge.json()).error.code,
		"request_too_large"
	);
	assert.equal((await request(`${path}?offset=-1`)).status, 400);
});
