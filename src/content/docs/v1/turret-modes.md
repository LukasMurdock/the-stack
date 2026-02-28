---
title: "Turret Modes"
description: "Understand off/basic/full behavior and graceful degradation."
pubDate: "2026-02-27"
---

# Turret Modes

Set `TURRET_MODE` per environment:

- `off`: disable ingestion.
- `basic`: disable ingestion, keep read/admin surfaces.
- `full`: enable ingestion when `TURRET_SIGNING_KEY` exists.

## Degradation rule

If `TURRET_MODE=full` and `TURRET_SIGNING_KEY` is missing, Turret degrades to `basic`.

In this state, ingestion endpoints return `503` with `code`:

- `TURRET_DEGRADED_MISSING_SIGNING_KEY`

## Verify mode

```bash
curl -s "http://localhost:4321/api/health"
```

Check `turret.configuredMode`, `turret.effectiveMode`, and `turret.reason`.
