---
title: "Database Guide"
description: "Run local and production-safe migration workflows."
pubDate: "2026-02-27"
---

# Database Guide

## Local workflow

```bash
just migrate-core
just migrate-turret
```

Use `just studio-core` and `just studio-turret` for inspection.

## New migration

```bash
just db-generate-core add_user_timezone
```

Review generated SQL before applying remotely.

## Production workflow

```bash
wrangler d1 migrations apply CORE_DB --env production
wrangler d1 migrations apply TURRET_DB --env production
```

Use expand/contract for schema changes that affect live traffic.
