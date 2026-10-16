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

Use `pnpm run deploy`: pnpm reserves bare `deploy` for its own use. `just deploy`
is an optional shortcut. Credentials and sender-domain ownership are supplied by
the app owner; infrastructure resources are created by the deployment workflow.
Never copy local `.env` secrets into a deployment automatically.

The deploy command:

1. Uses Void to connect and pin the intended Cloudflare account.
2. Uses Void's provisioning engine to create or reuse **separate** Core and
   Turret D1 databases, both KV namespaces, and the replay R2 bucket.
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

## Resource state and retries

Commit `void.lock.json` after provisioning. It contains resolved resource IDs,
so another machine or CI reuses the same resources. `.void-wrangler.jsonc`,
`.wrangler/local/wrangler.json`, and `dist/server/wrangler.json` are generated.
Keep credentials and local `.void` state out of Git.

A failure can leave successfully provisioned resources in your account. Rerunning
uses the recorded IDs and Void's resource discovery instead of creating copies.
If one database fails, migrations and application publication do not run. Core
and Turret must have distinct names and IDs, preserving their separate D1 limits.

## Why there is a small adapter

Void 0.28's public inference models one primary D1 database. The Stack uses two.
`scripts/provision-resources.mjs` calls the **installed Void provisioning engine**
once for each declared database; that engine owns account checks, discovery,
creation, locking, retries, and writing `void.lock.json`. The Stack does not
implement a second set of Cloudflare provisioning requests.

The SDK's internal entry points are isolated in `scripts/lib/void-cloudflare.mjs`
and checked against the exact pinned Void version. Updating Void requires
validating this adapter and its transport-level tests. Database migrations remain
explicit per database until Void offers a public multi-database workflow.

## Validate your new app

After deploying, check `/api/health`, `/api/readiness`, and `/api/doc`, test
sign-in and organization permissions, and complete the [email](email.md) and
[observability](observability-operations.md) acceptance checks. Bootstrap the first
administrator with `POST /api/internal/bootstrap-admin` and the
`x-bootstrap-secret` header.

Local development and browser tests use isolated local resources with remote
bindings disabled. `pnpm preview` runs locally. Cloud previews need their own
app configuration and lock state; a Worker version URL alone does not isolate data.

This workflow targets the app owner's Cloudflare account. A managed Void platform
is a separate target and needs compatibility validation for the custom bindings.
