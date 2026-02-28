# Contributing

Thanks for helping improve The Stack.

`just` is required for local development and contribution workflows.

Install `just`:

```bash
# macOS
brew install just

# Linux
cargo install just
```

## Local setup

1. Generate a Better Auth secret:

```bash
npx @better-auth/cli@latest secret
```

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
just new-api example-status
just new-route _public/example
```

## Validation

Before opening a PR, run:

```bash
just check-fast
```

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

Please include:

- Steps to reproduce
- Expected behavior
- Actual behavior
- Environment details (OS, Node version, browser)
