# Contributing

Thanks for helping improve The Stack.

## Local setup

Use Node 24.21.0+ (required by Void). Follow [Getting Started](src/content/docs/v1/welcome.md):

```bash
pnpm install
pnpm local:setup
pnpm dev
```

Setup initializes local configuration, migrates both local databases, and creates
a verified administrator. It preserves existing data and credentials. Sign in
using `.wrangler/.admin-password` and create an organization.
[The extension reference](src/content/docs/v1/extend.md) explains feature
ownership and permissions.

<!-- example:start -->

Open Projects in your organization to try the example.
[Build your first feature](src/content/docs/v1/first-feature.md) walks through a
persisted field.

<!-- example:end -->

Maintenance commands are `package.json` scripts, such as `pnpm local:seed`,
`pnpm routes:new _public/example` and `pnpm check`; the `justfile` only aliases
them. `pnpm local:seed` populates observability demos; it does not create
product data.

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
`oxlint-tsgolint` runs the type-aware rules (`oxlint --type-aware`): exhaustive
switches and unnecessary assertions everywhere, and promise ownership outside
the React UI.

`@typescript/native` provides `tsc`. The `typescript` alias supplies the
TypeScript 6 API required by framework tools and lint plugins.

While iterating, `pnpm verify:fast` runs lint, formatting, type checks and the
behavior suite without building. For full local verification:

```bash
pnpm verify
```

Before pushing to `main`, commit and run `pnpm proof`: it runs install,
`pnpm verify` and `pnpm test:e2e` on the committed tree in a clean temporary
checkout and records the result as a git note; push it with
`git push origin refs/notes/proof`. See "Trunk loop and proofs" in `AGENTS.md`.

To reset local state from scratch:

```bash
pnpm local:reset
```

Before deploying an app created from this starter, run:

```bash
pnpm check
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
and invitations are core capabilities; see
[the extension guide](src/content/docs/v1/extend.md).

<!-- example:start -->

Projects is a replaceable create/list example. `pnpm example:remove` deletes it,
including its tests, and leaves `pnpm verify` green.

<!-- example:end -->

`pnpm verify` runs lint, formatting, tests, type checks, and build. Browser tests
use isolated local D1 state: install Chromium with
`pnpm exec playwright install chromium`, then run `pnpm test:e2e`.
