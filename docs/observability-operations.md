# Operating The Stack's observability

Use this guide when adapting The Stack to your Cloudflare account. [Turret](turret.md) describes replay, errors, logs, and tracing; this guide covers operational metrics, backend health, and account setup.

## Starter defaults and account setup

The template includes structured API/page logs, Workers tracing at 5%, operational metrics, complete hourly replay totals, and an admin-only backend health view at `/app/ts_admin/turret`. Operational metrics remain enabled independently of `TURRET_MODE`; that setting controls replay ingestion.

| Included in the template                                 | Configure for each project                             |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Worker logs, spans, Issues, and source maps              | Real production resources, origin, and secrets         |
| `TURRET_METRICS` and production `ANALYTICS_SQL` bindings | Dataset access and deployed SQL schema verification    |
| Turret backend health and read-only query recipes        | Shared Cloudflare dashboards and alert destinations    |
| Request/Ray correlation controls                         | Domain tracing rules and sampling                      |
| Native log/trace persistence defaults                    | Retention requirements and optional export destination |

Start with the [deployment guide](DEPLOYMENT_GUIDE.md), then complete the acceptance checklist below in your own environment. The repository does not provision account dashboards, alerts, domain tracing, or export destinations. Locally, replay totals work from local D1; backend health queries display unavailable and do not connect to production Analytics SQL.

## Operational dataset v1

`TURRET_METRICS` writes `turret_operations` in production and `turret_operations_local` in local development. It is separate from the mixed replay/product dataset `turret_analytics`. Every API invocation emits one operational point, including auth, ingestion, admin, preflight, and CORS rejection. Requests that reach Astro emit one `page` point. Static assets served without invoking the Worker are not counted.

Metrics are independent of D1 breadcrumb persistence, replay mode, and console log sampling. They are best-effort writes, not a billing ledger or an uptime guarantee. A failed write emits `observability.metrics_failed` without changing the application response. Runtime termination can prevent emission; inspect native Workers metrics and external checks for those failures.

| Column  | Meaning                                                   |
| ------- | --------------------------------------------------------- |
| index1  | Environment; Analytics Engine sampling index              |
| blob1   | Schema version `v1`                                       |
| blob2   | Environment                                               |
| blob3   | Worker deployment ID, or `unknown`                        |
| blob4   | `api` or `page`                                           |
| blob5   | HTTP method                                               |
| blob6   | Normalized API path, or bounded Astro boundary `/astro/*` |
| blob7   | `application`, `auth`, `ingest`, `admin`, or `health`     |
| blob8   | Cloudflare colo, or `unknown`                             |
| double1 | Response duration in milliseconds                         |
| double2 | HTTP status                                               |
| double3 | 1 for 5xx; otherwise 0                                    |
| double4 | 1 for duration over 1000 ms; otherwise 0                  |
| double5 | 1                                                         |

Do not add raw URLs, cookies, user/session identifiers, query strings, SQL, or error text to this dataset. API paths use the existing Turret normalization; they are not guaranteed to be resolved framework route patterns. Avoid routes with sensitive values in path segments. Astro uses a bounded label because the Worker entry point does not know the resolved Astro route. Duration measures response creation, not completion of a streamed body or background work.

## Backend health and replay totals

`GET /api/internal/turret/summary` requires an authenticated admin. It returns a fixed one-hour interval ending at the start of the current minute. Replay counts include every stored session started in `[from, to)`, including sessions outside the recent ten-item preview. Error replay sessions count sessions with `has_error`, not individual exceptions. Counts reflect stored replay data, not all browser visits.

The backend health summary uses production-only `ANALYTICS_SQL`, two fixed parameterized queries, a five-second wait limit, and a thirty-second per-binding/environment cache with concurrent request coalescing. Admin and health traffic is excluded from health totals to reduce monitoring feedback. The top-ten route/deployment list is a ranking, not the source of total counts. Responses use `Cache-Control: no-store`.

Analytics Engine can sample and ingest asynchronously. SQL `COUNT`, `SUM`, and `AVG` apply sampling weights automatically; p95 uses explicit `sampleInterval` weights with `quantileWeighted`. Display these as estimates. Missing bindings, failed queries, and local environments display unavailable rather than zero. Local development does not connect to production Analytics SQL. The Astro adapter disables remote bindings during development/prerendering so builds do not require account selection or open a remote proxy; deployed production bindings still work normally.

## Verify the deployed SQL schema

The Analytics SQL binding requires Wrangler 4.145+. Configure the production bindings already present in `wrangler.json`, provision the real D1/KV/R2 resources, and deploy through the existing preflight/deployment workflow. An empty/new Analytics Engine dataset may not be discoverable until it receives points.

Use a token with Account Analytics Read plus any dataset-specific read permissions, scoped to the account. Keep it in `CLOUDFLARE_API_TOKEN` and the account in `CLOUDFLARE_ACCOUNT_ID`; never paste credentials into repository files. These commands perform reads only:

```bash
pnpm exec tsx scripts/observability.ts recipes
pnpm exec tsx scripts/observability.ts datasets
pnpm exec tsx scripts/observability.ts query totals
pnpm exec tsx scripts/observability.ts query routes
pnpm exec tsx scripts/observability.ts query release-errors
```

Inspect the dataset columns, including `sampleInterval`, against [SQL introspection](https://developers.cloudflare.com/analytics/sql-api/datasets/). The default environment is `production`; `APP_ENV` can select another environment's points. The dataset name is fixed to production `turret_operations`, matching this template's configuration. If you rename the production dataset, update the query constants and recipes together. Verify these queries against your deployed account before relying on backend health or enabling alerts.

## Alert recipes

Create custom alerts in Cloudflare; no notification destination is configured by the repository. These are starting thresholds, to be calibrated against real traffic. Exclude local data and synthetic test routes from production policies. Use failure rate alongside a minimum volume, and send a test alert to the chosen destination before considering rollout complete.

| Alert                           | Query/filter                                                                                                         | Initial condition                          | Window  |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------- |
| API failures                    | `api-error-rate` recipe                                                                                              | At least 100 requests and 5xx rate over 1% | 5 min   |
| Slow application routes         | `routes` recipe, grouped by route/version                                                                            | At least 100 requests and p95 over 1000 ms | 10 min  |
| Replay ingestion failures       | `ingestion-failures` recipe                                                                                          | At least 3 server errors                   | 5 min   |
| Metrics/replay storage failures | Workers logs: action is `observability.metrics_failed`, `turret.breadcrumb_failed`, or `turret.error_capture_failed` | At least 1                                 | 5 min   |
| SQL health query failures       | Workers logs: action is `observability.query_failed` or `turret.summary_failed`                                      | Repeated failures                          | 10 min  |
| Email submission failures       | Workers logs: action is `email.send_failed`                                                                          | At least 1                                 | 5 min   |
| Cleanup failures                | Workers logs: action is `turret.cleanup`, error exists                                                               | At least 1                                 | 70 min  |
| Missing cleanup success         | Workers logs: action is `turret.cleanup`, error absent, skipped absent                                               | No successful runs                         | 130 min |

The script's investigative recipes use one hour. For alerts, replace `$start`/`$end` with the alert evaluation window and supply environment/account scope as required by the dashboard. Worker log JSON field paths must be discovered through introspection with `include_custom_attributes=true`; do not assume raw console fields are top-level SQL columns. Convert the log filters above to SQL using the verified account schema. Ensure successful cleanup is expected in the selected environment before enabling an absence alert.

## Shared operations dashboard

Start with Cloudflare's API Performance template, then add panels for requests, 5xx rate, p95/average latency by route, failures by deployment, ingestion failures, and telemetry failures. Use native Workers CPU/wall time and invocation outcomes, D1 rows read/written and storage, R2 storage, and domain security/cache panels alongside application data. These native panels cover failures the application cannot log. Use the exact hourly window from Turret for comparisons. Save queries from `recipes` rather than rebuilding them during incidents.

For an investigation: identify deployment and time window; inspect `release-errors`; open the matching Turret issue/replay; copy its request ID to Workers logs and its Ray ID to Cloudflare Traces. A missing sampled trace is not proof that the request did not happen. Cross-dataset SQL joins are not required or assumed; correlate results in the investigation workflow.

## Domain tracing and context propagation

The template enables Workers tracing at 5%. [Cloudflare domain tracing](https://developers.cloudflare.com/observability/traces/configuration/) is separate and requires a custom domain/zone. Enable persistence and a modest baseline rate, then deploy temporary Trace Rules for the affected path during an incident. Rules match incoming traffic, so a higher path sampling rate does not mean all failed/slow responses are retained. Confirm supported cache, rule, and routing spans by searching an actual Ray ID.

Domain trace settings allow incoming W3C context and forwarding to an origin. This does not establish automatic propagation from a Worker's outbound fetch to external email providers or arbitrary services: the [Workers limitation](https://developers.cloudflare.com/workers/observability/traces/known-limitations/) still documents that gap. Keep request/Ray correlation and verify propagation before promising a joined external trace.

## Retention, export, and cost

Keep logs at 100% and Workers traces at 5% until real ingestion volume justifies tuning. Head sampling can drop failures. Track log/trace bytes and Analytics Engine usage separately; observability allowances do not replace every product's usage charges. Check [observability pricing and retention](https://developers.cloudflare.com/observability/pricing/) when deploying and when revising sampling or storage settings. Select Logpush or native OpenTelemetry export when required history exceeds native retention, choose a real destination and redaction policy, and verify delivery before disabling native persistence. No external export destination is selected here.

## Per-project acceptance checklist

- [ ] Generate an ordinary API request, an auth request, an ingestion request, and a dynamic page request. Verify one point per invocation, expected categories, and deployment IDs.
- [ ] Confirm replay totals exceed ten when more than ten sessions exist; verify the selected hourly boundaries and loading/unavailable states.
- [ ] Execute both summary SQL queries and confirm p95 weighting/column names. Compare aggregates with Workers invocation metrics while accounting for static assets, monitoring exclusions, sampling, and ingestion delay.
- [ ] Trigger controlled staging failures for application, ingestion, cleanup, and telemetry persistence. Verify logs, alerts, recovery, and request/Ray correlation without affecting production users.
- [ ] Confirm domain traces and chosen alert/export destinations. Record the verification date, deployment ID, and results in your project's operations notes.
