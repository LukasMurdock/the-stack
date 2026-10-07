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

Request IDs accept at most 128 characters from `A-Z`, `a-z`, digits, `.`, `_`, `:`, and `-`; otherwise the Worker generates a UUID. IDs provide correlation, not authentication or database identity. API responses echo `x-request-id`. Stored error and breadcrumb metadata includes the same ID and deployment version. Each breadcrumb has its own server-generated ID; spans reference that ID through a required foreign key. Replay groups spans by breadcrumb ID, so repeated caller-supplied request IDs cannot merge observations. The direct span reader is `/api/internal/turret/breadcrumb/{breadcrumbId}/spans`. Request logs use declared Hono route patterns, with `/api/*` for unmatched requests; application metadata omits query strings. Native URL query strings are redacted in Wrangler configuration. Raw email verification/reset links are logged only in local/dev/test environments using the explicit log transport.

Cleanup emits `action = "turret.cleanup"` on completion, skip, or failure, and rethrows failures so Cloudflare sees a failed invocation. Cloudflare sending errors preserve provider codes; Resend errors returned as data become exceptions. Auth email submission emits `email.accepted` with provider/message ID and failures emit `email.send_failed`. Acceptance is separate from delivery; see [email operations](email.md).

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

## Issue Investigation

An issue page opens one occurrence for investigation. By default it uses the representative occurrence: the most recent occurrence with a playable replay, or the most recent occurrence when none has one. The page shows:

- The occurrence's message, stack, and correlation fields (request ID, Ray ID, deployment, route, and status) for worker errors.
- The failing request and its D1 spans, matched by request ID. Request IDs can repeat, so Turret prefers the same replay session, then the closest timestamp.
- The replay, positioned 5 seconds before the occurrence.
- A timeline of requests, console output, errors, and feedback from that replay session. It shows 2 minutes before to 30 seconds after the occurrence by default, or the whole replay session.

The URL keeps `event` (the selected occurrence) and `t` (the replay position in epoch milliseconds), so a link reopens the same moment. Replay session pages also accept `t`. `GET /api/internal/turret/issue/{fingerprint}/event/{errorId}` returns the occurrence's context, including its newer and older neighbors.

## Feedback and Issues

Feedback can describe broken behavior that never raises an error, so reports are issue evidence alongside error occurrences. A report links to at most one issue, through `turret_issue_feedback`.

- **Create issue** promotes a report to its own issue, with the fingerprint `report:<feedback id>`. The issue title is the report's first line, and promoting the same report again opens the same issue.
- **Link to this issue** appears on reports in an investigation's timeline. It attaches a report from the same replay session to the issue under investigation, moving it from any other issue. `PUT /api/internal/turret/feedback/{id}/issue` does the same by fingerprint, and `DELETE` unlinks.
- Linking marks an open report as triaged. A report made after the issue was resolved reopens it as regressed, under the same rule as error occurrences. The report's deployment is the one that served its replay session.
- An issue exists while it has retained occurrences or linked reports. Issue counts include reports: the issue list has a reports count, and users and replay sessions include reporters. Links are deleted with their reports when feedback expires.
- The issue page lists linked reports. Selecting one (`report` in the URL) opens it like an occurrence, with its replay positioned 5 seconds before the report and the session timeline around it.

Error occurrences are still grouped only by fingerprint. Turret cannot yet attach an occurrence to a different issue or merge issues.

## Issue Triage

The issues list counts occurrences, replay sessions, and distinct users within the selected window. These are separate impact measures: a refresh starts a new replay session, so users are counted as distinct replay-session owners. Errors captured outside a replay session have no user. Organization impact is not counted, because membership lives in the core database.

First seen is the earliest retained occurrence, not the earliest in the window. Each row also compares the window's occurrences with the preceding window of equal length.

Views:

- **Open**: every open issue.
- **New**: open issues first seen in the window.
- **Escalating**: open issues with at least 10 occurrences in the window, and at least twice as many as in the preceding window.
- **Regressed**: open issues reopened by an occurrence after resolution.
- **Resolved** and **Ignored**.

Sort by last seen, users affected, occurrences, or explicit priority (high, medium, or low; medium by default).

## Issue Lifecycle

Issues are `open`, `resolved`, or `ignored`. Resolving an issue records `resolved_at`. A later occurrence of the same fingerprint reopens it with `regressed_at` set. That occurrence commits in the same batch as the error itself. The occurrence's timestamp decides recurrence, not when it arrives, so an error captured before the resolution and delivered afterward does not reopen the issue. Ignored issues stay ignored.

Each occurrence records the deployment that served the failing code in `deployment_id`. For worker errors, that's the Worker version. For client errors, it's the version that served their replay session. The issue page breaks occurrences down by deployment.

**Resolved in next deployment** records the current deployment in `resolved_in_version_id`. Later occurrences from that deployment are expected until the fix ships. An occurrence from any other deployment, or from an unknown one, reopens the issue. This option is unavailable when the runtime doesn't report a deployment, as in local development without version metadata.

A status change clears `regressed_at`, and repeating the current status changes nothing. Resolving again sets the resolution mode, so you can switch between resolving now and resolving in the next deployment. An absence of new occurrences does not confirm a fix unless the affected flow has been used since.

## Tracking a Fix

- **Owner:** each issue can have an owner chosen from administrators, with an **Assign to me** shortcut. The inbox filters by owner: anyone, assigned to me, or unassigned.
- **Links:** ticket and pull request URLs (http or https only) are kept on the issue. GitHub pull requests and issues display as `owner/repo#123`.
- **Activity:** the issue's activity lists investigation notes plus who changed the status, priority, owner, or links. Each change is recorded in the same D1 batch as the change itself, and only when the value actually changed, so repeating a status adds nothing.

### Recovery

A resolved issue shows whether replay traffic since resolution supports the fix. Turret compares the share of replay sessions with issue evidence (an occurrence or a linked report):

- **Before:** the 7 days before resolution.
- **After:** sessions started since resolution.

For an issue resolved in the next deployment, sessions the old deployment served don't count toward the after period. The verdicts are:

- **Likely fixed**: the earlier rate predicts at least 3 affected sessions since resolution, and none were affected. With no real change, that happens by chance about 5% of the time or less.
- **Not confirmed yet**: too little traffic to tell. An absence of new occurrences alone does not establish recovery.
- **Still occurring**: affected sessions since resolution.
- **Can't be measured**: no replay sessions before resolution showed the issue, such as worker errors outside replay sessions.

## Investigation Export

**Copy for coding agent** and **Download JSON** on an issue page export the current investigation, centered on the selected occurrence or report. The JSON comes from `GET /api/internal/turret/issue/{fingerprint}/export?event=…|report=…` and follows `turretInvestigationExportSchema`. The Markdown is rendered from the same export.

The export holds observed facts, never conclusions:

- the issue's impact and lifecycle, and occurrences by deployment
- the focused occurrence's message, stack, correlation IDs, and failing request with its D1 queries, or the focused report
- a timeline of the replay session's requests, errors, and reports, from 2 minutes before to 30 seconds after the focus
- linked reports, notes, ticket and pull request links, and the recovery verdict
- absolute links to the issue and the replay

A **Not captured** list names what it lacks, such as console output, sampled traces, a missing replay, or unmatched requests. That way an agent doesn't read absence as health.

The export omits who was affected: no user IDs, emails, or contact details. Report messages are included because they describe the problem. They're quoted in the Markdown and bounded in length, so they read as user-provided evidence rather than instructions.

## Product Outcomes

Errors and feedback miss tasks that fail quietly. Outcomes measure whether people complete a small set of important workflows. They're listed in `turretWorkflowSchema` (`src/contracts/turret-outcomes.ts`), currently creating a project and accepting an invitation.

An attempt starts, may fail any number of times, and ends at its first success. Events are recorded per attempt in `turret_outcome_attempts`, tied to the replay session that started it. Events can arrive out of order or more than once. Events from another replay session never change an attempt, and nothing changes after the first success.

Status is derived when read:

- **Succeeded**: reached success. Attempts that failed first are also counted as "after a failure", a sign of friction.
- **Failed**: one or more failures and no success, idle for 30 minutes.
- **Abandoned**: no failure and no success, idle for 30 minutes.
- **In progress**: otherwise.

A failure carries a short reason code: the API error code (`invalid_input`), the HTTP status (`http_503`), `network`, or `error`. It never includes the error message, which can contain user content. Attempts expire with their replay session.

The **Outcomes** page (`/ts_admin/turret/outcomes`) shows each workflow's attempts, success rate among finished attempts, failures, abandonment, and top failure reasons. It lists attempts by status, and **Watch replay** opens each at its last failure, its success, or where the user went quiet.

To measure another workflow:

1. Add it to `turretWorkflowSchema` and `turretWorkflowLabels`.
2. Call `useWorkflowOutcome(workflow)` where the task lives. Call `start()` where the user begins: first focus on a form, or arriving on a page with intent. Call `failed(error)` when an attempt to finish fails, and `succeeded()` when the task is done.

Recording is best effort and does nothing without an active Turret session.

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
