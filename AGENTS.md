# The Stack

The Stack owns product architecture: Astro pages, React/TanStack UI, Hono APIs,
Better Auth, organization authorization, Drizzle schemas, and Turret observability.
Void owns the infrastructure configuration and application deployment workflow.
This repository is a starter, with no existing production deployment or data.
Design defaults for newly created apps; do not invent an operational environment.

Write code by `TIGERSTYLE.md`. Where it differs from this repository's
established conventions (tabs, oxfmt output), the repository wins.
New scripts are TypeScript run by `node` (erasable syntax only), checked by
`tsconfig.scripts.json`; parse argv/env once with `scripts/lib/cli.ts`, and
test each CLI as a subprocess (`tests/tooling/cli-boundaries.test.ts`).

## Workflows

- Install: Node 24.21.0+ and the pinned pnpm version; `pnpm install`.
- Local setup: `pnpm local:setup`; develop: `pnpm dev`. It refuses to start
  while this checkout's server or another process holds the port.
  `pnpm dev:wait` polls `/api/health` with a deadline, `pnpm dev:stop` stops
  Astro and workerd, and `pnpm status` shows the PID. Do not `pkill -f`.
- Validate cheapest first: the touched test file
  (`pnpm exec tsx --tsconfig tsconfig.app.json --test <file>` or
  `pnpm test:e2e <spec>`), then `pnpm verify:fast` (lint, types and behavior
  tests, no build) while iterating, `pnpm proof` after committing, and
  `pnpm test:e2e` for browser contracts.
- Browser runs claim `STACK_E2E_PORT` or the first free port from 4322 and keep
  state and build output in `.wrangler/e2e/<port>`, so parallel checkouts and
  agents do not collide. A build is reused while its inputs are unchanged;
  `STACK_E2E_REBUILD=1` forces a rebuild.
- Commands are `package.json` scripts; `just` is optional and CI never uses it.
- Routes: `pnpm routes:new <path>` scaffolds a file; `pnpm routes` (or the dev
  server) regenerates `routeTree.gen.ts`. Route type errors after adding or
  moving a route usually mean a stale tree.
- Navigation: add a top-level area (label, icon, audience) in
  `src/react-app/components/nav-items.ts`; the header, phone bottom bar and
  `tests/e2e/navigation.spec.ts` follow it. Account, Admin, API docs and Sign
  out are in the account menu; browser specs open it with
  `tests/e2e/account-menu.ts`. Sub-tab rows use `ScrollTabs`.
- Tests: fake R2 with `tests/helpers/fake-r2.ts`. Columns are snake_case in SQL
  (`casing: "snake_case"`), so raw-SQL seeds use `organization_id`, not the key.
- Feature conventions: read `src/content/docs/v1/extend.md`.

<!-- example:start -->

- Projects is the removable example and first-feature walkthrough
  (`src/content/docs/v1/first-feature.md`). Core code and tests must not depend
  on it; wrap any line a shared file needs for it in `example:start`/`example:end`
  comments so `pnpm example:remove` (checked by
  `tests/tooling/example-remove.test.ts`) can delete it in one step.

<!-- example:end -->

- Paged lists return `pagedResponse` with a `page.total` from `readPage`; never
  count a page's rows. Break `created_at` ties with `insertionOrder(table)`, not
  random ids. Search user text with `literalContains`; D1 rejects long `LIKE`s.
- Deploy artifact: `pnpm check:deploy` builds the Worker
  `void deploy --platform cloudflare` would publish, offline and without
  credentials, and checks its imports, bindings and crons. `pnpm check` and
  `pnpm proof` run it; run it after touching Void, crons/, bindings or the build.
- Deploy: configure the app name, origin, sender, and secrets (below), then
  `pnpm run deploy`. Void provisions resources through the two-database adapter,
  migrations run independently, and Void publishes the app. See `docs/DEPLOYMENT_GUIDE.md`.
- First production admin: `BOOTSTRAP_SECRET=... pnpm admin:bootstrap` prints its
  password once (no email needed); add people from Admin → Users → Create user.
  Never write a generated password to a file or log. `pnpm run doctor` and
  `/api/readiness` report whether email can send.
- CI: `pnpm ci:wait [ref|pr]` waits for GitHub checks (default `HEAD`, which
  must be pushed), prints failing jobs' log tails, and exits non-zero on
  failure. Run it in the background instead of hand-written polling loops.
- Release: `pnpm ship` (trunk, the default) checks a clean tree, a passing
  proof of HEAD and that origin's main fast-forwards to it, pushes HEAD to main
  with `refs/notes/proof` in one atomic push, runs `pnpm run deploy`, then waits
  until `/api/health` reports the commit and prints the production URL and
  admin sign-in. `--dry-run` prints the checks and steps. PR-based teams and
  outside contributions use `pnpm ship <pr>` instead: it waits for CI, merges
  and fast-forwards main. Rerun either after a failure; nothing is pushed,
  merged or deployed twice. Only the operator's request authorizes a ship.

## Trunk loop and proofs

Work lands on `main` without pull requests, so the evidence is produced before
pushing:

1. Iterate with the touched test file and `pnpm verify:fast`.
2. Commit. `pnpm proof` refuses uncommitted or untracked changes.
3. `pnpm proof` checks HEAD out into a temporary directory, runs
   `pnpm install --frozen-lockfile`, `pnpm verify`, `pnpm check:deploy` and
   `pnpm test:e2e` there, and stores a JSON record as a git note
   (`refs/notes/proof`, replaced by a newer proof of the same commit). Logs are
   in `.proof/<sha>/`. `pnpm proof --check [rev]` passes only for a passing
   proof of that exact tree with the deploy step and e2e run (proofs recorded
   before the deploy step existed no longer pass); `--show` prints it.
4. `pnpm ship` pushes the commit and its note together and deploys. If main
   moved, rebase onto `origin/main` and prove again. CI on main fails when
   HEAD has no passing proof.

A proof shows that this commit's tree passed the suite on the recorded machine.
It is self-attested evidence, not security: anyone who can push can write a
note, and it says nothing about behavior the tests do not cover. Reviews are a
contract, not code: a reviewer (human, model or tool) records its verdict with
`pnpm proof --add-review <file.json>`; `--check --require-reviews <n>` enforces
a count where policy asks for one.

## Dependencies

Dependabot opens security updates only. Everything else lands as a proved
trunk commit: `pnpm deps:outdated` (also the weekly "Outdated dependencies"
workflow summary) lists updates grouped as patch and minor (one commit, with
the command to run), major (one commit each, after reading the changelog) and
held (`@types/node` follows the Node major in `engines`).

## Secrets

Production secrets live in Cloudflare Secrets Store (`secrets_store_secrets`
bindings). Never `wrangler secret put` or `void secret put` in production:
Void 1.1 pins a live Worker's plain secrets and uploads with its own uploader,
which cannot upload `FLAGS` or `ANALYTICS_SQL`, so the next deploy fails.
`pnpm check:deploy` and `pnpm run deploy` refuse plain secrets.

- Worker code reads secrets only from the request env, already resolved to
  strings by `resolveSecrets` (`src/worker/secrets.ts`) at the entry; use
  `requireSecret` for a required one. Never log a value.
- Add one: declare it in `src/contracts/secrets.ts` (required or optional,
  minimum length), add it to `productionSecretNames` in `config/cloudflare.mjs`,
  set it in `.env` locally, and create `<PREFIX>_<NAME>` in the store before
  deploying (`docs/DEPLOYMENT_GUIDE.md`, "Secrets"; deploy prints the command).
- Local dev reads `.env` strings; browser tests read the local Secrets Store
  that `prepare-e2e` seeds; unit tests may pass `{ get(): Promise<string> }`.
- A live Worker that still has plain secrets switches once with
  `pnpm secrets:switch store|create-secrets|switch` (dry run until
  `--execute`): it uploads the Store-based version without traffic, checks
  it on its preview URL, then deploys it, so sign-in never fails. Never
  delete the plain secrets first.

## Feature flags

Flags are Cloudflare Flagship behind the `FLAGS` binding
([docs/feature-flags.md](docs/feature-flags.md),
[Flagship](https://developers.cloudflare.com/flagship/)).

- Ship unfinished work behind a flag instead of holding it off `main`.
- Declare it in `src/contracts/feature-flags.ts` with an owner and an
  `expires` date; reading an undeclared key does not compile.
- Default to off, the existing safe behavior: the default is served whenever
  Flagship is missing or fails.
- Read flags once per request with `requestFlags` (Worker) or
  `useFlag` (browser, client flags only).
- Remove the flag and its dead branch once it is fully rolled out or expired;
  `verify` fails after `expires`.
- Migrations cannot hide behind flags: they are add-only and expand first.
- Local: `pnpm flags` lists what the local store serves,
  `pnpm flags on <key> --user <id>` turns one on for you, and
  `pnpm flags:local --reset` restores the defaults.

<!-- example:start -->

- `projects-total` gates the Projects example's count (`tests/e2e/projects.spec.ts`).

<!-- example:end -->

## Showing UI changes

Use these instead of throwaway Playwright or curl scripts, and give the human
the files they write:

- `pnpm shot <path...>` saves PNGs to `.wrangler/shots` (`--out before`, then
  `--out after`, for a comparison). Paths without a leading slash are under
  `/app`. Signed in as the local admin by default (`--as anonymous`, or
  `owner`/`viewer` with `--e2e`); `--viewport phone|desktop|<W>x<H>`, repeatable.
  It prints each page's status, console errors and failed requests, and exits
  1 if a page did not load or threw. It uses the running `pnpm dev` server, or
  with `--e2e` a fresh production build with seeded fixture users and no dev
  overlays.
- `pnpm api <METHOD> <path> [json]` sends one signed-in request (paths under
  `/api`) and prints the JSON; same `--as` and `--e2e`.
- `pnpm demo:record <spec>[:line]` runs one browser spec with video and writes
  `.wrangler/recordings/<spec>.webm` (and an `.mp4` when ffmpeg is installed).

## Infrastructure

`void.config.ts` is the Void entry point. Explicit Cloudflare bindings and local
variables live in `config/cloudflare.mjs`. Do not edit generated
`.void-wrangler.jsonc`, `.wrangler-local.json`, or `dist/server/wrangler.json`.
Commit `void.lock.json` when Void records provisioned IDs/history.

Core and Turret must keep separate D1 databases and migration histories to retain
independent D1 limits. Do not consolidate them. The deploy wrapper uses the
installed Void provisioning engine for both databases, both KV namespaces, and
the replay bucket. Do not add manual resource-create instructions or require IDs.
The engine records IDs in `void.lock.json`; validate the version-pinned adapter
in `scripts/lib/void-cloudflare.ts` when updating Void: compare the internals it
loads by name with the validated version, run `pnpm test:tooling` (partial-failure
recovery and reuse with a mocked cloud transport), then add the version to
`VALIDATED_VOID_VERSIONS`.
Void bundles `crons/` on its own and keeps only that bundle's entry file, so a
cron's import graph must not split into chunks: import the job module
(`src/worker/scheduled-cleanup.ts`), never the API Worker or anything with a
dynamic `import()`. `pnpm check:deploy` fails if a cron bundle splits. Void records the last build's `main` and `assets` in
`void.lock.json`; `pnpm run deploy` restores the authored values
(`scripts/lib/void-lock.ts`) before building and after publishing, and
`pnpm check:deploy` fails on a lock that still has them.
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
