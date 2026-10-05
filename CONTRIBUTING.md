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

Linting uses `.oxlintrc.json`. `pnpm run lint` runs Oxlint directly and rejects
lint errors. Fix violations rather than adding exceptions for existing code.

The selective anti-slop rules apply to owned JavaScript and TypeScript, including
tests. Prefer inference, typed bindings, boundary parsing, and `satisfies` over
assertions. When an assertion is necessary, add a nearby `// SAFETY:` comment
explaining the specific invariant; the comment must describe evidence, not just
silence lint. Do not add double assertions or a baseline.

The plugin is vendored from the revision recorded in
`tools/oxlint/anti-slop/UPSTREAM.json`. Preserve both MIT licenses and the
ESLint Stylistic provenance when updating it. Vendored source is excluded from
lint and formatting. Upgrade `oxlint` and `@oxlint/plugins` together at identical
exact versions, then run the plugin integration tests.
`pnpm test` synchronizes generated types, typechecks test fixtures, and runs the
Node test suite.

TypeScript 7 provides `tsc` through `@typescript/native`. The `typescript` alias
retains Microsoft's TypeScript 6 API for framework tools and JS lint plugins;
`tsc6` is available for diagnosing compatibility differences. Keep both packages.

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
