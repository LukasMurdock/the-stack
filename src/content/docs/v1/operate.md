---
title: "Operate Track"
description: "Deploy, verify, and roll back both production workers safely."
pubDate: "2026-01-18"
---

# Operate

Use this track for deployment, incident response, and production verification.

## Runbooks

- Production deploy and verification (`docs/DEPLOYMENT_GUIDE.md`)
- Greenfield environment setup (`docs/deploy_greenfield.md`)
- Data-safe migration strategy (`docs/deploy_never-take-down-production.md`)

## Production topology

The stack runs one production worker (`wrangler.json`).

Deploy and verify core health surfaces after every release.

## Incident baseline

- Keep latest known-good worker version ID.
- Practice rollback procedures in staging before production incidents.
