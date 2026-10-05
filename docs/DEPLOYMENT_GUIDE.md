# Deployment Guide (Production)

This guide is the canonical production deploy and rollback runbook.

## Topology

Production has one Worker:

- Main app Worker: `wrangler.json` (`the-stack-production`)

`pnpm run deploy` intentionally fails to prevent accidental deploys.

## Prerequisites

- Node.js + pnpm
- Cloudflare account + Wrangler auth
- Production IDs/secrets configured in `wrangler.json`

Before first deploy, replace placeholders in `wrangler.json`:

- `env.production.vars.APP_URL`, `ADMIN_EMAIL`, and D1 IDs

```bash
pnpm exec wrangler whoami
# If needed:
pnpm exec wrangler login
```

## Deploy (Go/No-Go)

### 1) Preflight

```bash
just preflight
```

Preflight validates:

- app production placeholders are removed
- app production D1 IDs are configured
- test/build pass
- dry-run deploy works

### 2) Deploy

```bash
just deploy-production
```

This deploys the main production worker.

### 3) Verify

```bash
curl -i "https://<your-domain>/api/health"
curl -i "https://<your-domain>/api/scalar"
```

Expected:

- `/api/health` returns `200` with `ok: true`
- `/api/scalar` returns `200`

Tail logs as needed:

```bash
pnpm exec wrangler tail --env production
```

For a new project, complete the [observability acceptance checklist](observability-operations.md#per-project-acceptance-checklist). Verify deployed metrics and the admin backend health view, then configure the dashboards, alerts, domain tracing, and exports your project needs.

## Rollback

### Roll back worker

```bash
pnpm exec wrangler versions list --env production --config wrangler.json
pnpm exec wrangler rollback <version-id> --env production --config wrangler.json
```

After rollback, re-run verify checks and keep incident notes with the version ID.
