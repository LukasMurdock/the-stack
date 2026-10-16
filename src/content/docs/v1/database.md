---
title: "Database Guide"
description: "Run local and production-safe migration workflows."
pubDate: "2026-02-27"
---

# Database Guide

## Local workflow

```bash
pnpm db:local:migrate
```

If you use the optional `just` task runner, `just studio-core` and
`just studio-turret` open the local databases for inspection.

## New migration

```bash
pnpm exec drizzle-kit generate --config src/bindings/d1/core/drizzle.config.ts --name add_user_timezone
```

Review generated SQL before applying remotely.

## Production workflow

```bash
pnpm run deploy
```

The release wrapper applies both migration directories before Void publishes the Worker.
See `docs/DEPLOYMENT_GUIDE.md` for configuration and release checks.

Use expand/contract for schema changes that affect live traffic.
