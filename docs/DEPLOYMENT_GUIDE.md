# Deployment Guide (Production)

This repo is designed to deploy a single Cloudflare Worker to production only.

Goals:

- Avoid accidental deploys to the wrong environment.
- Keep production deploys reversible (fast rollback).
- Provision Cloudflare resources once, then reference them via bindings in `wrangler.json`.

## Source of Truth

- Worker config: `wrangler.json`
- Deploy command: `npm run deploy:production`

This repo intentionally refuses to deploy without an explicit environment:

- `npm run deploy` fails on purpose
- Production deploy always uses: `--env production`

## Prerequisites

- Node.js + npm
- Cloudflare account with a zone for your domain
- Wrangler auth:

```bash
npx wrangler whoami
# If needed:
npx wrangler login
```

## Deploying to Production

### 1) Preflight

```bash
npm run check
```

This runs typecheck + build + a Wrangler deploy dry-run for production.

### 2) Deploy

```bash
npm run deploy:production
```

### 3) Verify

- Tail logs:

```bash
npx wrangler tail --env production
```

- Hit your health endpoint / critical path endpoints.

## Rollback (Fast)

If a deploy causes errors, rollback is the fastest way to restore service.

```bash
npx wrangler versions list --env production
npx wrangler rollback <version-id> --env production
```

After rollback:

- Keep the bad version id around for debugging.
- If the incident involved data writes, also consider temporarily disabling writes via an ops flag (see next section).

## Useful Commands

```bash
# Auth
npx wrangler whoami

# Validate deploy without changing production
npx wrangler deploy --config wrangler.json --env production --dry-run

# Deploy
npm run deploy:production

# Logs
npx wrangler tail --env production

# Versions / rollback
npx wrangler versions list --env production
npx wrangler rollback <version-id> --env production
```
