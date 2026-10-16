# Deploy a new app with Void

The Stack is a starter with no existing deployment or resources. Void provisions
its Cloudflare resources, records their IDs, and publishes its Astro/Hono Worker.
No dashboard resource creation or copying database/namespace IDs is required.

## Configure your app

In `config/cloudflare.mjs`, set:

- `appName`: your unique Worker name. Database and namespace names derive from it.
- `deploymentCloudflare.vars.APP_URL`: your deployed HTTPS origin.
- `ADMIN_EMAIL`: the address for your app's first administrator.
- `EMAIL_FROM` and `EMAIL_FROM_NAME`: your sender and product name.

Keep `localCloudflare` for local emulation. Local setup still needs no cloud account:

```bash
pnpm install
pnpm local:setup
pnpm dev
```

## Connect, configure secrets, and deploy

```bash
pnpm exec void connect --platform cloudflare
pnpm exec void secret put BETTER_AUTH_SECRET
pnpm exec void secret put BOOTSTRAP_SECRET
pnpm exec void secret put TURRET_SIGNING_KEY
pnpm verify
pnpm run deploy
```

Use `pnpm run deploy`: pnpm reserves bare `deploy` for its own use. `pnpm secret`
prints a random value for each prompt. Credentials and sender-domain ownership are supplied by
the app owner; infrastructure resources are created by the deployment workflow.
Never copy local `.env` secrets into a deployment automatically.

The deploy command:

1. Uses Void to connect and pin the intended Cloudflare account.
2. Uses Void's provisioning engine to create or reuse **separate** Core and
   Turret D1 databases, both KV namespaces, and the replay R2 bucket, then
   finds or creates the Flagship app for the `FLAGS` binding (below).
3. Builds and validates the Worker, then applies each database's own migrations.
4. Runs `void deploy --platform cloudflare` to configure email, publish the
   Worker, check readiness, and update schedules.

Void configures email from `void.config.ts`'s `email.from`, derived from your
sender setting. It reviews the domain/DNS changes before applying them. Select
a sender on a Cloudflare zone you own; existing mail providers' MX records are
preserved. Use `pnpm exec void email setup --platform cloudflare` before CI, and
see [email setup](email.md). Declining email setup deploys without delivery.

Analytics Engine datasets are created automatically on first write from their
configured bindings; there is no separate dataset-create command. See
[Cloudflare's setup guide](https://developers.cloudflare.com/analytics/analytics-engine/get-started/).
The Analytics SQL binding and Turret's hourly cleanup job are included.

It ends by printing the production URL, the sign-in path (`/app/login`), and
how the first administrator gets credentials (below).

## Release

After the first deploy, release the committed `main` with one command:

```bash
pnpm proof            # verify HEAD in a clean checkout; record a git note
pnpm ship --dry-run   # optional: print the checks and steps, change nothing
pnpm ship             # [--require-reviews <n>]
```

`pnpm ship` needs only git and an `origin` remote. It refuses unless the
working tree is clean, HEAD has a passing proof of its exact tree (e2e run),
and origin's `main` fast-forwards to HEAD; each refusal says what to do next.
It then pushes HEAD to `main` and `refs/notes/proof` in one `git push
--atomic` (first merging notes others pushed, never forcing), runs
`pnpm run deploy` with `STACK_COMMIT` set, and polls `${APP_URL}/api/health`
until it reports the commit several times in a row (Cloudflare can briefly
serve the previous version), then checks `/api/readiness`. Health reports
`commit`, the Git SHA the build was made from, and `version`, the Cloudflare
Worker version ID. CI on `main` fails if HEAD has no passing proof.

### Pull requests

Teams that release through pull requests, or a maintainer releasing an outside
contribution, use:

```bash
pnpm ci:wait 42      # optional: just wait for PR #42's checks
pnpm ship 42         # [--squash|--rebase] [--timeout <minutes>]
```

PR mode uses the `gh` CLI (honoring `GH_HOST`, `GH_TOKEN`, and `GH_REPO`) to
wait for every check run on the PR head, then `gh pr merge --match-head-commit`
so a head that moved after CI cannot merge. It fast-forwards the base branch,
then deploys and waits as above. Auto-merge or merge queues are not driven;
rerun `pnpm ship <pr>` once the PR has merged. `ci:wait` alone accepts a PR
number or any pushed ref (default `HEAD`).

Reruns are safe in both modes: a commit already on `main` with its note, or a
merged PR, is not pushed or merged again, and a commit production already
serves skips the deploy.

## Resource state and retries

Commit `void.lock.json` after provisioning. It contains resolved resource IDs,
so another machine or CI reuses the same resources. `.void-wrangler.jsonc`,
`.wrangler/local/wrangler.json`, and `dist/server/wrangler.json` are generated.
Keep credentials and local `.void` state out of Git.

A failure can leave successfully provisioned resources in your account. Rerunning
uses the recorded IDs and Void's resource discovery instead of creating copies.
If one database fails, migrations and application publication do not run. Core
and Turret must have distinct names and IDs, preserving their separate D1 limits.

## Feature flags (Flagship)

The `FLAGS` binding needs a [Flagship](https://developers.cloudflare.com/flagship/)
app; Void 0.28 cannot create one and refuses to publish the binding without
its ID. `pnpm run deploy` therefore looks for an app named after the Worker
(`appName`) with `wrangler flagship apps list`, creates it with
`wrangler flagship apps create` if there is none, and records its `app_id` in
`void.lock.json` like the database IDs. Later deploys reuse the recorded ID.

The deploy credentials need Flagship read and write access. If listing or
creating fails, deploy stops before publishing and prints the command to run:

```bash
pnpm exec wrangler flagship apps create <appName>
```

Rerun `pnpm run deploy` and it finds the app by name. If the credentials cannot
list apps, also set `app_id` on the `FLAGS` entry of
`deploymentCloudflare.flagship` in `config/cloudflare.mjs`; an `app_id` there
is used as is. Without the binding the app still runs and every flag serves its
registry default (`/api/readiness` reports `flags.binding`).

Flags themselves are created and rolled out in Flagship, not by deploy; a flag
the app does not have yet serves its default. See
[feature flags](feature-flags.md#production) for targeting, percentage
rollouts and the kill switch.

## Why there is a small adapter

Void 0.28's public inference models one primary D1 database. The Stack uses two.
`scripts/provision-resources.mjs` calls the **installed Void provisioning engine**
once for each declared database; that engine owns account checks, discovery,
creation, locking, retries, and writing `void.lock.json`. The Stack does not
implement a second set of Cloudflare provisioning requests.

The same adapter fills the gap for Flagship apps (above), through Wrangler's
documented `flagship apps` commands, and has Void record the ID.

The SDK's internal entry points are isolated in `scripts/lib/void-cloudflare.mjs`
and checked against the exact pinned Void version. Updating Void requires
validating this adapter and its transport-level tests. Database migrations remain
explicit per database until Void offers a public multi-database workflow.

## Validate your new app

After deploying, check `/api/health`, `/api/readiness`, and `/api/doc`, test
sign-in and organization permissions, and complete the [email](email.md) and
[observability](observability-operations.md) acceptance checks, then create the
first administrator.

## First administrator

```bash
read -rs BOOTSTRAP_SECRET && export BOOTSTRAP_SECRET   # the value you stored
pnpm admin:bootstrap                                   # [--url <origin>]
pnpm exec void secret delete BOOTSTRAP_SECRET          # once you have signed in
```

It calls `POST /api/internal/bootstrap-admin` with the `x-bootstrap-secret`
header and prints `ADMIN_EMAIL`'s generated password once. No email is needed
and nothing is written to disk; the Worker stores only Better Auth's hash. Then
sign in at `/app/login` and add people from Admin → Users → Create user.

With working email, `pnpm admin:bootstrap --delivery email` (or a request
without a body) emails a reset link instead; it answers 503 rather than
pretending to send when email is not configured.

How it is kept safe:

- Only the holder of `BOOTSTRAP_SECRET` can call it (constant-time compare), and
  only over HTTPS; the command refuses plain HTTP except to localhost.
- It works once per `ADMIN_EMAIL`: a KV flag makes later calls answer 409, so a
  leaked secret cannot mint more passwords. Delete the secret after first
  sign-in anyway; with no secret set the endpoint answers 401.
- If the address already has an account (someone registered it first), the
  password is replaced and every session ends, so that registrant is locked out.
- Responses are `Cache-Control: no-store`, and the password is never logged.

Recovery: if the admin password is lost and email does not work yet, someone with
Cloudflare access deletes the `bootstrap:admin:<admin email>` key from the
`CORE_KV` namespace and reruns `pnpm admin:bootstrap`.

Local development and browser tests use isolated local resources with remote
bindings disabled. `pnpm preview` runs locally. Cloud previews need their own
app configuration and lock state; a Worker version URL alone does not isolate data.

This workflow targets the app owner's Cloudflare account. A managed Void platform
is a separate target and needs compatibility validation for the custom bindings.
