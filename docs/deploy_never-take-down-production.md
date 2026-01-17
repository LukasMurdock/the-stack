# Never Take Down Production

## Core Strategy

- Two axes of safety:
    - **Compute safety:** ship code in a way you can instantly revert (Worker Versions / rollback, blue-green routing, canary).
    - **Data safety:** ship schema/state changes in a backwards-compatible way (D1 migrations, DO migrations, idempotent queue consumers).
- One principle: **never combine an irreversible data change with an untested code change in the same “blast window”.**

### Prefer a Kill Switch for Risky Changes

If you have endpoints that can cause cascading failures (writes, fan-out, queue enqueues), add an ops flag:

- Store in KV: `ops:disable_writes = "1"`
- In code: allow health checks, but block writes when enabled

This allows “stop the bleeding” without a redeploy.

## D1: Expand/Contract Migrations

Never ship a breaking schema change alongside code that depends on it.

### D1 Deployment

Always:

1. Add new columns/tables (non-breaking)
2. Deploy code that can read/write both old and new
3. Backfill existing data
4. Cut over reads to the new schema
5. Remove old schema later

### D1 Guardrails

- Always test migrations locally before remote.
- Use prepared statements (`bind()`) everywhere (prevents injection and avoids “string SQL surprises”).

### D1 Recovery

If a migration corrupts data, your plan is **D1 Time Travel restore** (but that’s still an incident—avoid needing it).

## Durable Objects: Migrations Are Effectively Permanent

Durable Objects have migration gotchas that can hard-down production if mishandled:

- `deleted_classes` destroys data permanently.
- No rollback mechanism for migrations; tags must be unique/sequential.
- RPC requires a sufficiently new `compatibility_date`.

### Durable Objects Deployment

- Never delete/rename classes in the first step; do additive changes first.
- If you must rename, follow “rename preserves data and IDs” patterns carefully and stage it.
- Use `--dry-run` before production deploy for migration validation (as a release gate).
- Avoid DO singletons; shard per-entity to prevent a single hot object from becoming a production bottleneck (503s).

## Queues: Idempotency + Message Versioning

Queues are at-least-once: duplicates are guaranteed to happen eventually.

### Safe queue design

- Idempotency is mandatory, assume duplicates, consumers must be safe to retry (store processed IDs somewhere durable):
    - Often KV is used for “processed msg id -> ttl 24h”, but if you need strong correctness, use D1/DO.
- Prefer `json` content type if you need dashboard visibility or pull consumers.
- Configure:
    - `max_retries`, `retry_delay`, and a **dead-letter queue**.
- Have an incident lever:
    - Ability to **pause the queue** if a new deploy starts poison-looping messages (pause is often the fastest way to stop cascading failures).
- Version payloads and support both versions during transitions.

Consider splitting workers:

- One Worker for HTTP traffic
- Separate Worker(s) for queue consumers (so you can rollback/scale/limit CPU independently)

## KV: Eventual Consistency

KV is great for read-heavy config/caching, but it’s eventually consistent (~60s global propagation).

Rules:

- Do not rely on global read-after-write correctness checks against KV (especially during deploy).
- Don’t use KV as the source of truth for “must be correct immediately” flags (use DO or D1 if consistency is required).
- For feature flags: KV is fine if your rollout model tolerates propagation delay. For “kill switch now”, prefer a DO-backed config stub or a Worker version rollback.

## R2: Immutable-First

R2 is usually safe operationally, but failures come from application logic:

- Prefer writing new keys/prefixes rather than mutating existing objects in place.
- Validate object keys (prevent .. traversal patterns).
- Use `httpEtag` (quoted) for caching headers, conditional GETs (304), and correctness.
- For large uploads: multipart rules (uniform part sizes, part numbers start at 1) and abort on failure.

## Release gates

Pre-prod checklist (automatable in CI):

- `wrangler deploy --dry-run` (validate config, bundling, migrations plan)
- Integration smoke tests against staging environment resources
- Remote dev sanity check (`wrangler dev --remote --env staging`) for binding correctness

Prod rollout checklist:

- Deploy candidate (versioned or blue/green)
- Run 3–5 smoke checks against production endpoints
- Monitor errors/latency + queue DLQ rate + DO 503s
- Ramp rollout percentage (if using canary)
- Keep rollback steps pre-written and practiced

## Incident runbooks

When production breaks, you want a deterministic “press these buttons” plan:

- Compute regression: rollback Worker (versions rollback or route flip back to blue)
- Queue consumer regression: pause queue + rollback consumer worker + drain DLQ after fix
- D1 bad migration/data issue: stop writes (feature flag / rollback) then consider Time Travel restore (last resort)
- DO migration issue: rollback compute won’t rollback DO schema; mitigate via compatibility code paths, traffic gating, or routing away from the impacted feature
