# Contributing

Thanks for helping improve The Stack.

## Local setup

Follow [Getting Started](src/content/docs/v1/welcome.md):

```bash
pnpm install
pnpm local:setup
pnpm dev
```

Setup initializes local configuration, migrates both local databases, and creates
a verified administrator. It preserves existing data and credentials. Sign in
using `.wrangler/.admin-password`, create an organization, and open Projects.

[Build your first feature](src/content/docs/v1/first-feature.md) walks through a
persisted field. [The extension reference](src/content/docs/v1/extend.md) explains
feature ownership and permissions.

`just` is optional for local development. Install it with `brew install just`
(macOS) or `cargo install just` (Linux) to use maintenance recipes such as
`just seed`, `just new-route _public/example`, and `just preflight`.
`just seed` populates observability demos; it does not create organizations or projects.

## Validation

Pre-commit formatting runs automatically on staged files via `lint-staged` + Husky.

Before opening a PR, run:

```bash
pnpm lint
pnpm test
pnpm run format:check
```

`pnpm run lint` uses Oxlint with `.oxlintrc.json`. For necessary type assertions,
add a nearby `// SAFETY:` comment explaining why the asserted type is valid.
`pnpm test` runs the behavior tests without rebuilding or generating files.
Before adding tests, follow [the test portfolio constraints](tests/AGENTS.md):
inspect existing claims, keep permutations at their lowest useful layer, and
reserve browser workflows for properties that require real UI or Worker bindings.
`pnpm test:types` checks test types, including the compile-only RPC guarantees.

When updating the vendored lint plugin, use the revision in
`tools/oxlint/anti-slop/UPSTREAM.json`, preserve its licenses and provenance,
and run `pnpm test:tooling` for lint configuration and plugin integration checks.
Keep `oxlint` and `@oxlint/plugins` at matching exact versions.

`@typescript/native` provides `tsc`. The `typescript` alias supplies the
TypeScript 6 API required by framework tools and lint plugins.

For full local verification:

```bash
pnpm verify
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
