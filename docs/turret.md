# Turret

Turret is The Stack's built-in observability platform.

It combines session replay (rrweb), error monitoring, structured logs, native tracing, and operational metrics.

## What Turret Does

- Session replay (rrweb)
- Error monitoring (client + worker)
- Structured request logs (Evlog wide events)
- Native Workers traces and Issues
- Operational metrics and admin backend health (Analytics Engine + Analytics SQL)
- Complete hourly replay totals (D1)

## Vocabulary

Turret uses explicit terms so replay debugging and product analytics do not blur together.

- Replay session: one rrweb capture stream created by `/api/turret/replay-session/init`. A browser refresh creates a new replay session.
- Journey: one browser-tab journey identified by `journeyId`. It is stored in `sessionStorage` and can group multiple replay sessions across refreshes.
- Visit: a Plausible-style analytics session that ends after 30 minutes of inactivity. This is not implemented yet and should not be confused with replay sessions.
- User: an authenticated Better Auth user identified by `userId`.
- Active user: a distinct `userId` with Turret activity in a selected time window.
- Current user: a distinct `userId` with activity in the last 5 minutes.
- Request: one backend API request breadcrumb, optionally linked to a replay session through `x-turret-session-id`.
- Span: a lower-level operation within a request, currently D1 query spans.
- Issue: a grouped error identified by fingerprint and tracked through issue state.
- Event: a structured log or product/operational fact. Evlog is the current substrate for wide events.

Naming rule: use "replay session" in UI and docs when referring to rows in `turret_sessions`. Reserve "visit" for a future 30-minute inactivity analytics session.

See [operational metrics and rollout](observability-operations.md) for the backend health summary, full hourly replay totals, alert recipes, domain tracing, and the read-only SQL helper. Complete its per-project acceptance checklist when deploying a new application.

## Structured Logs

The Worker initializes Evlog in `src/worker/observability/evlog.ts`.

Cloudflare Workers Logs and Query Builder are the primary short-term log query surface.

Current behavior:

- Emits one wide event for every API request, including auth, ingestion, admin, CORS rejection, and preflight requests. Replay exclusions do not disable logging.
- Includes request ID, method, route template, status, duration, Ray ID, colo, Turret session context, environment, deployment version, and D1 summary fields.
- Sends structured JSON objects to Cloudflare Workers Logs through the console, with failures at error level.
- Preserves original exceptions and stacks, capturing each failure once in Turret. Hono-handled exceptions are read from `c.error`.
- Writes Turret breadcrumbs and errors with `waitUntil`, using original bindings so observability writes do not count themselves.
- Uses Evlog redaction for common sensitive values before console output.

Evlog is the structured logging substrate. Turret remains the product surface for replay, errors, request breadcrumbs, spans, feedback, and issues.

Cloudflare configuration lives in `wrangler.json`:

```jsonc
"observability": {
    "enabled": true,
    "redact_query_string": true,
    "issues": { "enabled": true },
    "logs": { "enabled": true, "head_sampling_rate": 1, "invocation_logs": true },
    "traces": { "enabled": true, "head_sampling_rate": 0.05 }
}
```

Use Cloudflare Query Builder from the Worker's Observability page.

Useful filters:

- API request logs: `action = "api.request"`
- Email log-only mode: `action = "email.log_only"`
- Email send failures: `action = "email.send_failed"`
- Replay session correlation: `turret.sessionId = "<session-id>"`
- Route template: `route.pathTemplate = "/api/..."`
- Worker errors: `error.kind Exists`
- Slow API requests: `durationMs Greater than 1000`
- D1-heavy requests: `d1.queries Greater than 10`

Useful groupings:

- Group by `route.pathTemplate` to find noisy routes.
- Group by `error.kind` to separate exceptions from HTTP 5xx responses.
- Group by `cloudflare.colo` to spot regional issues.
- Group by `turret.sessionId` to inspect one replay session's backend activity.

## Native Traces and Issues

Cloudflare provides backend diagnostics; Turret connects browser errors and replay to those diagnostics. Workers Issues groups backend failures, including returned 5xx responses and error logs. `app.onError` passes the original Error to the console so Cloudflare receives its stack. Uploaded source maps support Cloudflare diagnostics; stacks stored directly in Turret remain runtime stacks.

Named native spans cover `api.request`, `auth.request`, `turret.ingest`, `turret.admin`, `email.send`, and `turret.cleanup`. Request spans carry `request.id`, `turret.session_id`, `http.route`, `app.env`, and `app.version`. Local/test contexts without `ctx.tracing` run normally. An inbound `traceparent` logged by evlog is not proof that external trace context propagates; Cloudflare currently documents external propagation limitations.

The Astro Worker boundary also emits `page.request` logs and spans, echoes request IDs, and records operational metrics using the bounded route label `/astro/*`. Static assets served without invoking the Worker do not pass this boundary.

Native tracing captures D1, KV, R2, and outbound fetch operations. Traces are sampled at 5%; keep replay breadcrumbs for unsampled requests. Turret's D1 capture handles prepared statements, chained binds, and batches on eligible application routes. Auth, ingestion, and admin routes rely on native database traces; their wide events have `d1.captured = false` rather than claiming a complete query count.

Detailed replay spans are capped at 100 per request, while summary counters include all captured operations. `d1.droppedSpans` reports truncation. Span timestamps represent query start time. Batch spans share the batch's elapsed wall time; summing them is not exclusive database time. `first` and `raw` results have no D1 row metadata. Spans are inserted in groups of seven to stay within D1's 100-parameter limit.

Request IDs accept at most 128 characters from `A-Z`, `a-z`, digits, `.`, `_`, `:`, and `-`; otherwise the Worker generates a UUID. IDs provide correlation, not authentication. API responses echo `x-request-id`. Stored error and breadcrumb metadata includes the same ID and deployment version. Request logs use normalized paths; application metadata omits query strings. Native URL query strings are redacted in Wrangler configuration. Raw email verification/reset links are logged only in local/dev environments without a Resend key.

Cleanup emits `action = "turret.cleanup"` on completion, skip, or failure, and rethrows failures so Cloudflare sees a failed invocation. Resend errors returned as data become exceptions, so failed delivery is traced and logged rather than silently treated as success.

## Investigation Queries

Save these recipes in the account's Cloudflare Query Builder after deployment:

| Name                        | Filters                                                               | Grouping / measurement                                                   |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Backend failures by release | `action = "api.request"`, `status >= 500`                             | Count by `app.version`, `route.pathTemplate`, `error.kind`               |
| Slow application routes     | `action = "api.request"`, `durationMs > 1000`                         | Duration percentiles by `route.pathTemplate`                             |
| Replay investigation        | `turret.sessionId = "<session-id>"`                                   | Inspect `requestId`, status and D1 summary; match `request.id` in traces |
| Ingestion failures          | `action = "api.request"`, path starts `/api/turret/`, `status >= 500` | Count by route and deployment                                            |
| Cleanup failures            | `action = "turret.cleanup"`, error exists                             | Inspect exception and deployment                                         |
| Incomplete replay spans     | `action = "api.request"`, `d1.droppedSpans > 0`                       | Count by route                                                           |

Saved queries and issue notifications are account configuration; this repository does not create them or contact external services. Use error-rate and latency queries alongside Workers metrics (CPU time, wall time, request volume) before tuning sampling.

## Retention and Export

Keep logs at 100% initially so low-volume failures remain discoverable. Traces are independently sampled at 5% and are not guaranteed for every failed request. Cloudflare head sampling drops the whole invocation's logs; lowering it is not an error-preserving sampling policy.

Prefer [native OpenTelemetry export](https://developers.cloudflare.com/workers/observability/opentelemetry-export/) for a future external logs/traces destination. Configure an actual destination in Cloudflare, then reference its name in Wrangler. Use `persist: false` only when the external destination should replace Cloudflare storage. Workers metrics cannot be exported through this facility. No external destination or in-process evlog drain is configured.

Check current [observability pricing and retention](https://developers.cloudflare.com/observability/pricing/) for your plan when deploying. Choose an export destination when your application's retention requirements exceed native storage. See the [operations guide](observability-operations.md#retention-export-and-cost) for sampling and cost considerations.

References: [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [Issues](https://developers.cloudflare.com/workers/observability/issues/), [Custom spans](https://developers.cloudflare.com/workers/observability/traces/custom-spans/), [D1 span attributes](https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/#d1), [Trace limitations](https://developers.cloudflare.com/workers/observability/traces/known-limitations/).

## Operation Modes

Turret supports explicit runtime modes via `TURRET_MODE`:

- `off`: disable Turret ingestion endpoints.
- `basic`: keep Turret read/admin surfaces, but disable ingestion.
- `full`: enable Turret ingestion if `TURRET_SIGNING_KEY` is present.

Default mode is `full`.

If `TURRET_MODE=full` but `TURRET_SIGNING_KEY` is missing, Turret degrades to `basic`.
In this state, ingestion endpoints return `503` with a stable error code instead of `500`.

Ingestion endpoint error codes:

- `TURRET_DISABLED`
- `TURRET_BASIC_NO_INGEST`
- `TURRET_DEGRADED_MISSING_SIGNING_KEY`

## Storage & Data Flow

- Replay chunks: R2 `TURRET_REPLAY_BUCKET`
- Index + metadata: D1 `TURRET_DB`
    - `turret_sessions`
    - `turret_session_chunks`
    - `turret_session_errors`
- Compliance bundle + config: KV `TURRET_CFG`
- Replay/error aggregates: Analytics Engine `TURRET_ANALYTICS`
- Operational request metrics: Analytics Engine `TURRET_METRICS`
- Backend health queries: production `ANALYTICS_SQL` binding

## Security Model

- Same-origin ingestion only
    - Blocks `Sec-Fetch-Site: cross-site`
    - Requires `Origin === new URL(APP_URL).origin` when `Origin` is present
- Signed upload tokens
    - `/api/turret/replay-session/init` issues a signed upload token
    - Upload endpoints require `Authorization: Bearer <token>`
- Internal playback is admin-only
    - `/api/internal/turret/*` gated by Better Auth admin sessions

## Console Logs

Turret records browser console output into the rrweb stream so logs are time-aligned with replay and errors.

Default behavior:

- Enabled for every session
- Levels: `log`, `info`, `warn`, `error`
- Tight limits to reduce size and risk:
    - `lengthThreshold: 200`
    - `stringLengthLimit: 300`
    - `numOfKeysLimit: 30`
    - `depthOfLimit: 2`

Note: rrweb's console recorder will also attach a `window.error` listener when `error` is included in the level list, so you may see overlap with Turret's explicit error reporting.

## Errors & Replay Correlation

Turret links errors to replay time so you can jump directly to the moment things broke.

- Client maintains:
    - `sessionId`
    - `lastRrwebTsMs` (from rrweb event timestamps)
- Client sends correlation headers on `/api/*` requests:
    - `x-turret-session-id: <uuid>`
    - `x-turret-replay-ts: <epoch-ms>`

Timestamp rule:

- `ts = lastRrwebTsMs ?? Date.now()`

Worker capture behavior:

- Record thrown exceptions for `/api/*`
- Record any returned `5xx` responses for `/api/*`

Replay bounds:

- `turret_sessions.rrweb_start_ts_ms` and `turret_sessions.rrweb_last_ts_ms` are updated during chunk ingest.

## Debugging

Use these endpoints to validate worker error capture end-to-end:

- `GET /api/throw` throws an error
- `GET /api/fail` returns a 500

Use these checks to validate mode behavior:

- `GET /api/health` returns `turret.configuredMode`, `turret.effectiveMode`, and `turret.reason`.
- `POST /api/turret/replay-session/init` returns:
    - `200` in full mode with valid signing key
    - `503` in off/basic/degraded mode

## References

- rrweb: https://www.rrweb.io/
- Tail Workers: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/
- OpenTelemetry export: https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- D1 debugging/observability: https://developers.cloudflare.com/d1/observability/debug-d1/
