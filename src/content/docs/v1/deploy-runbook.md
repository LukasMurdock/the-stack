---
title: "Deploy Runbook"
description: "Deploy and verify an app created from this starter."
pubDate: "2026-02-27"
---

# Deploy Runbook

This starter has no existing deployment. Configure your app using
`docs/DEPLOYMENT_GUIDE.md` before its first deployment.

## Preflight

```bash
pnpm check
```

## Deploy

```bash
pnpm run deploy
```

This applies both D1 migration chains, then deploys with Void using `void.config.ts`
and the app deployment bindings in `config/cloudflare.mjs`. See
`docs/DEPLOYMENT_GUIDE.md` for required configuration and migration caveats.

## Verify

```bash
curl -i "https://<your-domain>/api/health"
curl -i "https://<your-domain>/api/scalar"
```

## Rollback

```bash
pnpm exec wrangler rollback <version-id> --name the-stack
```
