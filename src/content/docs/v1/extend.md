---
title: "Extend Track"
description: "Add features safely using existing patterns and guardrails."
pubDate: "2026-02-27"
---

# Extend

Use this track when adding new product features.

## Recommended sequence

1. Add API route scaffold (`just new-api <name>`).
2. Add app route scaffold (`just new-route <path>`).
3. Add smoke tests for new path behavior.
4. Update docs with verify and rollback notes.

## Guardrails

- Keep changes deploy-safe (expand/contract for data changes).
- Add feature flags for risky behavior.
- Keep runtime defaults fail-closed.
