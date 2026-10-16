# The Stack

The Stack owns product architecture: Astro pages, React/TanStack UI, Hono APIs,
Better Auth, organization authorization, Drizzle schemas, and Turret observability.
Void owns the infrastructure configuration and application deployment workflow.
This repository is a starter, with no existing production deployment or data.
Design defaults for newly created apps; do not invent an operational environment.

## Workflows

- Install: Node 24.21.0+ and the pinned pnpm version; `pnpm install`.
- Local setup: `pnpm local:setup`; develop: `pnpm dev`.
- Validate: `pnpm verify`; browser contracts: `pnpm test:e2e`.
- Feature conventions: read `src/content/docs/v1/first-feature.md` and `extend.md`.
- Deploy: configure the app name, origin, sender, and secrets, then
  `pnpm run deploy`. Void provisions resources through the two-database adapter,
  migrations run independently, and Void publishes the app. See `docs/DEPLOYMENT_GUIDE.md`.
- CI: `pnpm ci:wait [ref|pr]` waits for GitHub checks (default `HEAD`, which
  must be pushed), prints failing jobs' log tails, and exits non-zero on
  failure. Run it in the background instead of hand-written polling loops.
- Release: `pnpm ship <pr>` waits for CI, merges, fast-forwards main, runs
  `pnpm run deploy`, then waits until `/api/health` reports the merged commit and
  prints the production URL and admin sign-in. Rerun it after a failure; it does
  not merge twice. Only the operator's request authorizes a ship.

## Infrastructure

`void.config.ts` is the Void entry point. Explicit Cloudflare bindings and local
variables live in `config/cloudflare.mjs`. Do not edit generated
`.void-wrangler.jsonc`, `.wrangler/local/wrangler.json`, or `dist/server/wrangler.json`.
Commit `void.lock.json` when Void records provisioned IDs/history.

Core and Turret must keep separate D1 databases and migration histories to retain
independent D1 limits. Do not consolidate them. The deploy wrapper uses the
installed Void provisioning engine for both databases, both KV namespaces, and
the replay bucket. Do not add manual resource-create instructions or require IDs.
The engine records IDs in `void.lock.json`; validate the version-pinned adapter
in `scripts/lib/void-cloudflare.mjs` when updating Void. `pnpm test:tooling`
checks partial-failure recovery and reuse with a mocked cloud transport.
Preserve `src/worker.ts` as the API/Astro dispatcher. Void publication wraps
framework Workers; `crons/turret-retention.ts` delegates its scheduled event to
the existing Turret cleanup handler.

Local and E2E use separate generated configurations with remote bindings disabled.
Keep production IDs, customer data, and secrets out of local test fixtures.
Previews require their own Worker and resources; a local preview server is not
an isolated cloud deployment. This repository targets the user's Cloudflare
account through Void; a managed Void platform needs separate compatibility work.

## Void reference

Use the installed version's docs at `node_modules/void/docs/`, especially
`integrations/frameworks/astro.md`, `reference/config.md`, and
`reference/cli/deploy.md`. Start with `guide/quickstart.md` and `reference/cli.md`
for commands. The linked `.agents/skills/void` skill follows the pinned package.
