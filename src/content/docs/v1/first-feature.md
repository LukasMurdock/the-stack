---
title: "Build Your First Feature"
description: "Add a persisted project status from D1 to a typed API and React form."
pubDate: "2026-10-07"
---

# Build your first feature

Start with [Getting Started](/docs/v1/welcome/): sign in, create an organization,
and create a project. This walkthrough changes your copy of the starter to let
owners and editors choose an initial project status: `planned`, `active`, or `done`.
Viewers can read it. The field survives refresh and defaults to `planned` for
existing records and API callers that omit it.

This is a creation-time field. Changing an existing project's status is a later
feature. The starter does not already include the changes below.

## 1. Declare the contract

In `src/features/projects/contracts.ts`, after the imports, add:

```ts
export const projectStatuses = ["planned", "active", "done"] as const;
export const projectStatusSchema = z.enum(projectStatuses);
```

Add this property inside `createProjectSchema`'s `z.object`:

```ts
status: projectStatusSchema.default("planned"),
```

`projectSchema` already extends `createProjectSchema`, so its response includes
status too. The HTTP route uses these same input and response schemas; OpenAPI
will describe the field automatically. The default keeps existing create callers
working while validating any explicitly supplied status.

## 2. Store the field in D1

In `src/bindings/d1/core/schema/projects.ts`, add this import:

```ts
import { projectStatuses } from "../../../../features/projects/contracts";
```

Add a column inside the table's column object, after `description`:

```ts
status: text({ enum: projectStatuses }).notNull().default("planned"),
```

The enum options give Drizzle the same TypeScript vocabulary as the wire contract.
SQL stores text; the operation's schema provides runtime validation. The database
also needs a default so existing rows receive a value when the column is added.

Stop the dev server and generate a new migration:

```bash
pnpm exec drizzle-kit generate --config src/bindings/d1/core/drizzle.config.ts --name project_status
```

Review the new SQL under `src/bindings/d1/core/drizzle/`. It should add a non-null
`status` column with default `planned`, equivalent to:

```sql
ALTER TABLE `projects` ADD `status` text DEFAULT 'planned' NOT NULL;
```

Do not modify previous migrations or their snapshots. Apply the new migration locally:

```bash
pnpm exec wrangler d1 migrations apply CORE_DB --local
pnpm test:migrations
```

The migration check applies complete chains to isolated local D1 databases and
compares them with the test schemas. It does not reset your normal local data.

## 3. Connect the operation

In `src/features/projects/operations.ts`, find the `.select({ ... })` inside
`createProject`. After its `description` expression, add:

```ts
status: sql<string>`${fields.status}`.as("status"),
```

Place `status` after `description` in both the table and the select object:
insert-from-select maps values by position, so their order must match.

That insert selects its values from an organization with a membership predicate.
Keep both `requireMembership(..., "edit")` and the predicate inside the SQL
statement. A browser role check helps presentation; the server must enforce access,
including membership changes between the initial check and the write.

`listProjects` selects all table columns, so it already reads the new field.

## 4. Follow the typed API to the browser

Inspect `src/features/projects/http.ts`: POST validates `createProjectSchema` and
returns `projectResponseSchema`; GET returns `projectsResponseSchema`. All three
now include status. No new endpoint or route registration is needed for this field.

Inspect `src/react-app/features/projects/queries.ts`: `createProjectMutation`
derives its input from the Hono client using `InferRequestType`, parses the response
with the shared schema, and invalidates the organization's project queries on
success. The new input flows through this existing code without a second payload
interface or a manually constructed URL.

## 5. Add the form field and display

In `src/react-app/features/projects/ProjectsPage.tsx`, change the existing contracts
import to:

```ts
import {
	createProjectSchema,
	projectStatusSchema,
} from "../../../features/projects/contracts";
```

Inside the existing `create.mutate({ ... })` input, after `description`, add:

```ts
status: projectStatusSchema.parse(fields.get("status")),
```

Inside the form's existing disabled `fieldset`, before its submit button, add:

```tsx
<label htmlFor="project-status">Status</label>
<select
	id="project-status"
	name="status"
	defaultValue="planned"
	className="h-9 w-full rounded-md border bg-background px-3 text-sm"
>
	{projectStatusSchema.options.map((status) => (
		<option key={status} value={status}>
			{status}
		</option>
	))}
</select>
```

The options come from the validator. The field uses the existing pending state and
form reset behavior. Keep `can(organization.role, "edit")` around `CreateProject`.

In the project list, inside each `li` after its description paragraph, add:

```tsx
<p className="text-sm text-muted-foreground">Status: {project.status}</p>
```

The list is available to viewers; the create form is available to owners and editors.

## 6. Verify persistence and permissions

Strengthen the existing test named `example writes require editor access and lists
isolate tenants` in `tests/integration/product.test.ts`. Add `status: "active"` to
its editor's create input. After the existing name and description assertions, add:

```ts
assert.equal(project.status, "active");
assert.equal(
	(await projects.listProjects(f.actor("viewer"), f.organizationId))[0]
		?.status,
	"active"
);
```

Keep the existing viewer-write rejection and other-organization isolation checks.
The fixture executes the full migration chain, so these assertions check the field
through the actual operation and stored data rather than a mock.

Run:

```bash
pnpm exec oxfmt --write .
pnpm verify
pnpm dev
```

Open your organization and select Projects. Your old project should show
**Status: planned**. Create **Launch beta** with **active**, refresh, and verify
**Status: active** remains. Open `/api/scalar` and inspect the Projects POST/GET
schemas to see the field.

For a browser check, add a Status selection and a post-refresh status assertion to
the existing project creation test in `tests/e2e/projects.spec.ts`, then run:

```bash
pnpm exec playwright install chromium
pnpm test:e2e tests/e2e/projects.spec.ts
```

Use the existing test rather than duplicating its login and organization workflow.
Browser tests use isolated D1 state; they do not reset your normal local databases.

## Make it your product

The same path applies to your own feature: contract → table and migration →
permission-protected operation → HTTP route → typed query or mutation → screen.
For a new endpoint, retain chained Hono route registrations so `ApiType` includes
it. Use the [extension reference](/docs/v1/extend/) when replacing Projects.

For initial branding, edit `src/pages/index.astro`, `src/layouts/Layout.astro`,
and `src/layouts/DocsLayout.astro`; configure `PRODUCT_NAME` and `EMAIL_FROM_NAME`
in `wrangler.json` for auth and email. Product documentation lives under
`src/content/docs/`.

Follow the [deployment runbook](/docs/v1/deploy-runbook/) when ready to publish.
Review and apply production migrations deliberately before deploying compatible
code; local migration commands above affect only your machine.
