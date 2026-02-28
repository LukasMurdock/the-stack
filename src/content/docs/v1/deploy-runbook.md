---
title: "Deploy Runbook"
description: "Deploy and verify the production worker with reproducible rollback steps."
pubDate: "2026-02-27"
---

# Deploy Runbook

## Preflight

```bash
just preflight
```

## Deploy

```bash
just deploy-production
```

This deploys the production worker in `wrangler.json`.

## Verify

```bash
curl -i "https://<your-domain>/api/health"
curl -i "https://<your-domain>/api/scalar"
```

## Rollback

```bash
npx wrangler rollback <version-id> --env production --config wrangler.json
```
