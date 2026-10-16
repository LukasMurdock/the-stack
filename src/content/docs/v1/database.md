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

`pnpm db:studio:core` and `pnpm db:studio:turret` open the local databases in
Drizzle Studio for inspection.

Columns are snake_case in SQL and camelCase in schema keys: Drizzle runs with
`casing: "snake_case"`, and a unit test rejects explicit names that break the
rule. Raw SQL, such as a seed script, uses the SQL names (`organization_id`).

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
