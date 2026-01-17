# Turret

Turret is The Stack's built-in observability platform.

It starts with session replay (rrweb) and grows into a unified view of errors, logs, traces, and aggregated metrics.

## What Turret Does

- Session replay (rrweb)
- Error monitoring (client + worker)
- Aggregated metrics (Analytics Engine)

## Storage & Data Flow

- Replay chunks: R2 `TURRET_REPLAY_BUCKET`
- Index + metadata: D1 `TURRET_DB`
  - `turret_sessions`
  - `turret_session_chunks`
  - `turret_session_errors`
- Compliance bundle + config: KV `TURRET_CFG`
- Aggregates: Analytics Engine `TURRET_ANALYTICS`

## Security Model

- Same-origin ingestion only
  - Blocks `Sec-Fetch-Site: cross-site`
  - Requires `Origin === new URL(APP_URL).origin` when `Origin` is present
- Signed upload tokens
  - `/api/turret/session/init` issues a signed upload token
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

## References

- rrweb: https://www.rrweb.io/
- Tail Workers: https://developers.cloudflare.com/workers/observability/logs/tail-workers/
- Analytics Engine: https://developers.cloudflare.com/analytics/analytics-engine/
- OpenTelemetry export: https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/
- D1 debugging/observability: https://developers.cloudflare.com/d1/observability/debug-d1/
