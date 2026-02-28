# Deployment Guide (Production)

This guide is the canonical production deploy and rollback runbook.

## Topology

Production has one Worker:

- Main app Worker: `wrangler.json` (`the-stack-production`)

`npm run deploy` intentionally fails to prevent accidental deploys.

## Prerequisites

- Node.js + npm
- Cloudflare account + Wrangler auth
- Production IDs/secrets configured in both Wrangler configs

Before first deploy, replace placeholders in `wrangler.json`:

- `env.production.vars.APP_URL`, `ADMIN_EMAIL`, and D1 IDs

```bash
npx wrangler whoami
# If needed:
npx wrangler login
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
npx wrangler tail --env production
```

## Rollback

### Roll back worker

```bash
npx wrangler versions list --env production --config wrangler.json
npx wrangler rollback <version-id> --env production --config wrangler.json
```

After rollback, re-run verify checks and keep incident notes with the version ID.
