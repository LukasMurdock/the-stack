---
title: "Operate Track"
description: "Deploy, verify, and roll back the production worker safely."
pubDate: "2026-01-18"
---

# Operate

Use this track for deployment, incident response, and production verification.

## Runbooks

- Production deploy and verification (`docs/DEPLOYMENT_GUIDE.md`)
- Greenfield environment setup (`docs/deploy_greenfield.md`)
- Observability setup and acceptance checks (`docs/observability-operations.md`)
- Data-safe migration strategy (`docs/deploy_never-take-down-production.md`)

## Production topology

The stack runs one production worker (`wrangler.json`).

Deploy and verify core health surfaces after every release.

## Incident baseline

- Keep latest known-good worker version ID.
- Practice rollback procedures in staging before production incidents.

## Observability

Turret includes replay and errors, correlated request logs, native Workers traces, and operational metrics. The admin dashboard at `/app/ts_admin/turret` shows complete hourly replay totals and sampled backend health. Backend health queries require a deployed production Analytics SQL binding; local development displays them as unavailable. The replay-user card counts distinct users with unexpired replay sessions started in the last 24 hours. It measures retained capture evidence, not complete user activity; it has no previous-period growth comparison.

For each new project, verify telemetry against the deployed account and configure the dashboards, alert destinations, domain tracing, and retention/export policy you need. Use the checklist in `docs/observability-operations.md`.
