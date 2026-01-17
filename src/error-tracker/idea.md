Giants

- https://www.datadoghq.com/
- https://sentry.io/welcome/
- https://www.highlight.io/
- https://jam.dev/
- https://betterstack.com/

---

- Logs >> [Tail Workers](https://developers.cloudflare.com/workers/observability/logs/tail-workers/) >> [Analytics Engine](https://developers.cloudflare.com/analytics/analytics-engine/) for aggregated metrics
- [OpenTelemetry endpoint](https://developers.cloudflare.com/workers/observability/exporting-opentelemetry-data/)
    - Traces - Traces showing request flows through your Worker and connected services
    - Logs - Application logs including console.log() output and system-generated logs
    - Note: exporting Worker metrics and custom metrics is not yet supported.

```
┌─────────────────────────────────────────────────────────────────┐
│                    Error Tracker Worker                         │
│                                                                 │
│  ┌─────────────────────┐    ┌─────────────────────────────────┐│
│  │  HTTP Interface     │    │  RPC Interface                  ││
│  │  (fetch handler)    │    │  (WorkerEntrypoint)             ││
│  │                     │    │                                 ││
│  │  • Browser SDK      │    │  • captureException(error, ctx) ││
│  │  • CORS             │    │  • captureMessage(msg, level)   ││
│  │  • API key auth     │    │  • flush()                      ││
│  │  • Rate limiting    │    │                                 ││
│  │  • Untrusted input  │    │  • Trusted (same account)       ││
│  └──────────┬──────────┘    └──────────────┬──────────────────┘│
│             │                              │                    │
│             └──────────────┬───────────────┘                    │
│                            ▼                                    │
│                   ┌─────────────────┐                           │
│                   │  Core Processing│                           │
│                   │  • Fingerprint  │                           │
│                   │  • Analytics Eng│                           │
│                   │  • D1 upsert    │                           │
│                   │  • R2 storage   │                           │
│                   └─────────────────┘                           │
└─────────────────────────────────────────────────────────────────┘
```

Architecture (Single Worker)

- One public Worker hosts:
    - Ingestion: /v1/session/init, /v1/session/:id/chunk, /v1/session/:id/error, /v1/session/:id/finish
    - Playback/admin API: /v1/sessions, /v1/session/:id/meta, /v1/session/:id/chunks
    - Compliance config API (admin-only): /v1/admin/compliance, /v1/admin/retention/run (optional)
    - Retention job: scheduled() handler to purge expired sessions
- Storage:
    - R2 stores rrweb chunks (raw), optionally “session meta snapshots”
    - D1 indexes sessions/chunks/errors for query + pagination
    - KV stores compliance bundle + short-lived upload tokens (and optionally simple rate limit counters)
    - Analytics Engine stores aggregates (ingestion volume, error counts, status/outcome counts)
- Observability:
    - Enable Workers logs/traces; optionally OTEL export to your vendor later
    - For “server error tracking into your DB”, rely on a top-level try/catch around routing that records an error event + links it to session_id if present
      Why this covers “integrated replay + error tracking” without a second Worker:
- Client errors go to /error and link to replay by session_id.
- Server errors get captured in the Worker catch-all and written to the same session_errors table, so you can jump from a 500 to the session replay.

---

Phase 1: Core MVP (Replay Ingest + Playback)

1. Bindings + config (wrangler)

- Add bindings for:
    - R2_BUCKET (R2)
    - DB (D1)
    - CFG (KV) for compliance + tokens
    - ANALYTICS (Analytics Engine dataset)
- Set observability.enabled = true (and traces if you want them).
- This is also where you decide “geo/storage” strategy:
    - simplest: one R2 bucket location chosen at provisioning time
    - if you need residency switches: multiple buckets bound (e.g. R2_US, R2_EU) and policy selects which to write

2. D1 schema (minimum viable)

- sessions(session_id pk, started_at, ended_at, initial_url, last_url, user_agent, has_error, error_count, chunk_count, policy_version, retention_expires_at, user_id/anon_id)
- session_chunks(session_id, seq, r2_key, size, sha256, created_at)
- session_errors(session_id, ts, source, message, stack, fingerprint, extra_json)

3. Token model (abuse protection)

- /session/init issues session_id + short-lived upload_token.
- Token can be:
    - Stateless HMAC (fast) + include exp, session_id, policy_version
    - Or “stateful-lite”: token id stored in KV for revocation/rotation
- Enforce:
    - strict CORS allowlist
    - payload size caps
    - per-IP/per-session rate limits (KV counters are fine to start)

4. Ingest endpoints

- POST /v1/session/init
    - Loads compliance bundle from KV (more on that below)
    - Writes a sessions row (started_at, policy_version, retention_expires_at)
    - Returns rrweb config derived from policy (masking rules, network capture rules), plus token
- POST /v1/session/:id/chunk
    - Validate token -> session match
    - Validate schema + enforce max bytes
    - Write chunk to R2: replay/v1/{session_id}/chunk/{seq}.json
    - Insert chunk row in D1, increment chunk_count
    - Write AE datapoint: “chunk_ingested”, bytes, etc.
- POST /v1/session/:id/error
    - Store normalized error in D1; set has_error=1, increment counters
    - Optionally store “client breadcrumbs” in R2 if too large for D1
    - Write AE datapoint: “client_error”
- POST /v1/session/:id/finish
    - Set ended_at; optionally write a meta.json to R2 for faster reads

5. Playback endpoints (admin-protected)

- GET /v1/sessions?has_error=1&since=... (D1 query + pagination)
- GET /v1/session/:id/meta (D1 session row)
- GET /v1/session/:id/chunks?cursor=... (list via D1 chunk index; fetch from R2 as needed)

---

Phase 2: “Integrated Server Error Tracking” (without Tail Worker)
Goal: if the Worker throws (or returns 500), you still get a session_errors row linked to the replay.

1. Add a global router wrapper

- Extract session_id from x-session-id header (sent by the browser on all requests)
- Create a request_id
- try { route(...) } catch (err) {
    - normalize error (message/stack/fingerprint)
    - write session_errors with source='worker'
    - set sessions.has_error=1
    - write AE datapoint: “worker_exception”
    - return sanitized 500 response with x-request-id

2. Structured logging

- Always console.error({ request_id, session_id, route, err }) so dashboard logs + OTEL have the same IDs.
  This gets you most of what Tail Workers give you for error tracking, with less moving parts. Tail Workers remain a “v2” option if you later want passive capture of all console logs/exceptions without relying on your catch-all.

---

Phase 3: Compliance + Retention (Configurable)

1. Compliance bundle in KV (versioned)

- Key: cfg:compliance:active -> { version, masking, network_capture, retention_days, geo_policy }
- /session/init pins policy_version into the session row so the entire session stays consistent.

2. Admin API to update compliance

- PUT /v1/admin/compliance updates KV and bumps version.
- Guard with an admin secret / JWT (whatever your internal auth is).
- KV is eventually consistent; pinning policy_version avoids mid-session drift.

3. Retention enforcement (scheduled)

- scheduled() runs hourly/daily:
    - query D1 for expired sessions
    - delete R2 prefix replay/v1/{session_id}/ (list + batch delete)
    - delete D1 rows
    - write AE datapoint “session_deleted”

---

Phase 4: Optional upgrades (only if needed)

- Durable Objects: only if you need strict chunk ordering (seq) or want near-real-time playback later.
- Queues: if chunk ingest volume gets high and you want to buffer R2/D1 writes.
- Tail Worker: if you want a passive “everything that happened in production” stream (logs + uncaught exceptions), independent of app code paths.
- OTEL export: if you want to ship traces/logs to a vendor; keep AE for custom metrics.
