# Contributing

Thanks for helping improve The Stack.

See `docs/ROADMAP.md` for current priorities and rollout phases.

`just` is required for local development and contribution workflows.

Install `just`:

```bash
# macOS
brew install just

# Linux
cargo install just
```

## Local setup

1. Copy local env vars and set required values:

```bash
cp .dev.vars.example .dev.vars
just secret-auth
```

Set these in `.dev.vars` before `just setup`:

- `BETTER_AUTH_SECRET`
- `APP_URL` (use `http://localhost:4321` for local)
- `ADMIN_EMAIL`

2. Bootstrap local environment:

```bash
just setup
```

3. Run the app:

```bash
just dev
```

Optional helpers:

```bash
just doctor
just status
just seed
just new-route _public/example
```

## Validation

Pre-commit formatting runs automatically on staged files via `lint-staged` + Husky.

Before opening a PR, run:

```bash
just check-fast
pnpm run format:check
```

`pnpm run lint` uses Oxlint with `.oxlintrc.json`. For necessary type assertions,
add a nearby `// SAFETY:` comment explaining why the asserted type is valid.
`pnpm test` runs the behavior tests without rebuilding or generating files.
`pnpm test:types` checks test types, including the compile-only RPC guarantees.

When updating the vendored lint plugin, use the revision in
`tools/oxlint/anti-slop/UPSTREAM.json`, preserve its licenses and provenance,
and run `pnpm test:tooling` for lint configuration and plugin integration checks.
Keep `oxlint` and `@oxlint/plugins` at matching exact versions.

`@typescript/native` provides `tsc`. The `typescript` alias supplies the
TypeScript 6 API required by framework tools and lint plugins.

For full local verification:

```bash
just check-full
```

To reset local state from scratch:

```bash
just reset
```

Before production deploys, run:

```bash
just preflight
```

## Pull requests

- Keep PRs focused and small when possible.
- Include context on what changed and why.
- Link related issues when relevant.
- Update docs when behavior or setup changes.

## Reporting bugs

For security vulnerabilities, follow `SECURITY.md`.

Please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node version, browser)

## Organization starter

After setup, open `/app/organizations`. Organizations, membership permissions,
and invitations are core capabilities. Projects is a replaceable create/list
example; see [the extension guide](src/content/docs/v1/extend.md).

`pnpm verify` runs lint, formatting, tests, type checks, and build. Browser tests
use isolated local D1 state: install Chromium with
`pnpm exec playwright install chromium`, then run `pnpm test:e2e`.
