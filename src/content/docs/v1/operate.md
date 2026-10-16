---
title: "Operate Track"
description: "Configure and operate an app created from this starter."
pubDate: "2026-01-18"
---

# Operate

Use this track when configuring and operating your own app. The starter has no
existing deployment or resources.

## Runbooks

- First deployment and verification (`docs/DEPLOYMENT_GUIDE.md`)
- Greenfield environment setup (`docs/deploy_greenfield.md`)
- Observability setup and acceptance checks (`docs/observability-operations.md`)
- Data-safe migration strategy (`docs/deploy_never-take-down-production.md`)

## App topology

The starter combines the marketing site, documentation, and API in one Worker.
Configure your app’s deployment bindings in `config/cloudflare.mjs`.

Deploy and verify core health surfaces after every release.

## Incident baseline

- Keep latest known-good worker version ID.
- Practice rollback procedures in staging before production incidents.

## Observability

Turret includes replay and errors, correlated request logs, native Workers traces, and operational metrics. The admin dashboard at `/app/ts_admin/turret` shows complete hourly replay totals and sampled backend health. Backend health queries require a deployed Analytics SQL binding; local development displays them as unavailable. The replay-user card counts distinct users with unexpired replay sessions started in the last 24 hours. It measures retained capture evidence, not complete user activity; it has no previous-period growth comparison.

For each new project, verify telemetry against the deployed account and configure the dashboards, alert destinations, domain tracing, and retention/export policy you need. Use the checklist in `docs/observability-operations.md`.
