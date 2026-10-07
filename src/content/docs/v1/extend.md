---
title: "Extend Track"
description: "Organizations as a foundation, with a small scoped example."
pubDate: "2026-02-27"
---

# Extend

Organizations, memberships, and invitations are core capabilities. Owners manage
membership; editors and owners can create example projects; viewers can read
them. Platform administrator access does not bypass organization permissions.

Projects demonstrates two operations: create and list. It uses ordinary React
forms, the existing typed Hono client, and TanStack Query. It supplies no editing
workflow, history, archiving, command protocol, or form framework.

## Source map

| Concern                            | Location                                           |
| ---------------------------------- | -------------------------------------------------- |
| Organization policy and operations | `src/features/organizations/`                      |
| Example operations                 | `src/features/projects/operations.ts`              |
| Input and response contracts       | `src/features/projects/contracts.ts`               |
| Example table                      | `src/bindings/d1/core/schema/projects.ts`          |
| Example HTTP routes                | `src/features/projects/http.ts`                    |
| Example client queries             | `src/react-app/features/projects/queries.ts`       |
| Example screen                     | `src/react-app/features/projects/ProjectsPage.tsx` |
| Protected route lifecycle          | `src/react-app/routes/_authenticated.tsx`          |

The example's operations enforce membership, including a permission predicate
inside the insert. The UI role check controls presentation. Copy the portions
that fit your feature; the folder arrangement is not a feature registration system.

To replace Projects, remove its route registration from `src/worker/api/index.ts`,
its client screen and queries, and the Projects link from the organization layout.
Replace its contracts, operations, and table with your own. Core readiness and
organization entry links do not depend on Projects. Generate a migration when
changing stored data; do not rewrite migrations already applied to an environment.

## Client ownership

The shared HTTP client and response handling live in `react-app/api.ts`;
`react-app/auth.ts` owns the auth client and the signed-in route requirement.
Each feature owns its client queries, transport-specific code, and state.
Organizations owns invitation onboarding; ordinary login has no feature-specific
registration branches. Turret owns recording, reporting, admin transport and
queries under `react-app/features/turret/`.

`react-app/startup.ts` captures invitation fragments before router initialization
and connects optional replay metadata to the HTTP client. The transport itself
has no Turret dependency. Admin access checks run in parent route layouts;
server endpoints still enforce permissions on every request.

`features/organizations/policy.ts` owns role vocabulary, assignable roles, and permission-to-role mappings for both UI
visibility and server predicates. The browser uses `can`; writes retain their
membership checks inside the SQL statement. Role choices and native input bounds
come from the input schemas instead of separate UI lists and limits.

Feature query modules own mutation options and cache invalidation. Screens supply
success callbacks for presentation effects, such as resetting a draft or changing
the displayed page. Endpoint middleware belongs in its `createRoute` definition,
so authentication and body limits follow path changes.

Organizations' `invitationToken.ts` owns invitation link construction, recognition,
and token capture. Link creation and verification callbacks use the same helper;
the UI displays the expiration returned by the server.

HTTP paths and wire contracts belong to the server routes. Retain the value returned
by chained Hono route registrations so `ApiType` includes each endpoint. Client
calls use `apiClient`; derive request and response types from those calls instead
of repeating URL strings or payload interfaces. Simple requests live in their
query options. Keep adapters for useful input conversion, such as numeric UI
filters to HTTP query strings.

`jsonOrThrow` infers successful JSON from an RPC response. A native `Response`
returns `unknown` unless a runtime schema is supplied. A supplied decoder must accept the RPC success payload; its output can transform that data. RPC typing does not validate
network data at runtime; replay initialization and stored replay chunks also use
schemas because their consumers require decoding or defaults.

## Boundaries

Lists return pages of 50 rows, using `offset` up to 100,000. HTTP bodies for these
resources are limited to 16 KiB. Offset pagination is deliberately simple; it is
not a consistent snapshot while records are being added or removed.

Creates are single attempts with no automatic retries or idempotency protocol.
If a response is lost, inspect the list before submitting again. Add stronger
workflow guarantees when the product requires them.

Invitation links expire after seven days. A matching invitation permits account
creation even when public signup is disabled. Registration uses Better Auth;
membership is granted only after the matching email has been verified. Revoked,
expired, and mismatched invitations cannot register an account or grant access.

The browser removes invitation fragments before router or replay initialization.
Session storage preserves the token across navigation, with an in-memory fallback
when storage is blocked. Verification emails carry the invitation in their callback
fragment so they can open in another tab. That tab also scrubs the fragment before
initialization. With storage blocked, reload the original invitation link if the
tab is reloaded before acceptance.

Acceptance retries recognize an existing membership without restoring removed
members or changing their role. Owner transfer and organization deletion are not
supplied. Identity changes clear client caches and stop the previous replay capture.

## Verification

`pnpm test` runs the behavior suite without generating files or rebuilding.
`pnpm test:types` checks test types, including compile-only RPC guarantees.
The behavior suite checks declared dependencies and browser runtime import boundaries.
Database fixtures execute complete migrations, including historical SQLite compatibility,
and compare their columns, indexes, and foreign keys with the Drizzle schemas.
`pnpm test:migrations` applies both migration chains to isolated local D1 databases
and checks that their schemas match the test fixtures. CI and `pnpm verify` require it.
`pnpm test:tooling` checks lint configuration and plugin integration when changing
template tooling. `pnpm verify` runs lint, formatting, the build, test type checks,
and the behavior suite.
`pnpm test:e2e` builds a Worker with isolated local D1 state under `.wrangler/e2e`;
it applies real migrations and uses local Worker bindings, including R2 for the
replay round trip. It does not reset normal local data. Install Chromium once with
`pnpm exec playwright install chromium`.

Apply production migrations deliberately before publishing compatible code.
See the [deployment runbook](/docs/v1/deploy-runbook).

`contracts/turret-policy.ts` owns recording defaults and bounds for KV normalization,
replay initialization, and settings drafts. `contracts/operation.ts` owns product error
codes and statuses; the HTTP adapter derives its documented responses from them.
Organization names, project names, and invited users’ display names have independent
input constraints, so changing one does not silently change the others.

`contracts/turret-features.ts` owns feature flag validation and defaults. Configuration
patches reuse their policy schemas’ bounds, reject undeclared fields, and preserve
omitted settings, including nested console serialization options. Defaults apply
when normalizing stored configuration, not when applying a partial update.

`contracts/turret-pagination.ts` owns Turret page defaults and bounds. Admin HTTP
routes validate numeric query parameters before querying storage; invalid bounds
return `400` rather than silently clamping or removing the SQL limit. Dashboard
navigation takes its default page sizes from the same contracts.

`contracts/turret-ingest.ts` owns the replay wire limit and the recorder's derived
batch target. Both client and server measure UTF-8 JSON bytes. The Worker limits
the actual request stream before JSON parsing, regardless of `Content-Length`.
The recorder flushes before exceeding its batch target and stops with a
`replay_payload_limit` status if a single event or pending upload exhausts its
bounded buffer. This stops recording while retaining the signed telemetry session. Upload routes share mode and session-token authorization.

`worker/turret/chunks.ts` owns immutable chunk commits. Conditional R2 writes
preserve the first payload at a sequence; identical retries repair or acknowledge
the commit, while different content returns `409`. D1 batches commit metadata,
counts, and timestamp bounds together, with a unique `(session_id, seq)` index.
The chunk identity migration keeps the latest duplicate metadata and repairs
stored counts. It cannot recover payloads overwritten before that migration.

If an upload acknowledgement fails, capture stops with `replay_upload_failed`
instead of continuing a replay with missing events or reusing the sequence for
another batch. Signed errors and feedback remain available until the server's
`upload_expires_at` deadline. At expiry, capture ends and correlation clears;
context reads also reject expired credentials when background timers are delayed.
Capture does not automatically renew; reload the page to start a new signed session.

Telemetry retention is resolved in `worker/turret/retention.ts`: session-linked
records inherit the session expiry; unavailable or missing session metadata uses
the short fallback. Feedback still requires session user metadata to be stored.
Expired replay sessions are hidden from lists and rejected by replay readers and
upload authorization immediately. The hourly cleanup removes expired telemetry
and feedback, then purges up to ten replay sessions, selecting 99 chunk metadata rows and 99 R2
objects per session. Prefix listing also finds objects whose metadata write failed.
R2 objects are deleted before their database references; failures retain those
references for retry, and large sessions resume on later runs. Retention changes
apply to newly initialized sessions; existing sessions keep their recorded expiry.
Invitation capture validates the token with the acceptance operation's schema.

Password recovery uses one feature-owned screen; the old token-in-path route
redirects to it. The router builds recovery callbacks with the SPA base path.
`contracts/auth.ts` supplies password bounds to registration, recovery, and
Better Auth configuration.

`contracts/turret-time-range.ts` owns epoch timestamp validation and half-open
`[from, to)` ranges. Trend queries can produce at most 1,000 buckets, including
partial edge buckets. Missing endpoints use the endpoint's default window,
anchored to the requested end. Browser search preserves numeric navigation values
and serialized URL values; ordering is validated when the range is queried.

`react-app/features/turret/session.ts` owns the signed session and recorder lifetimes.
`features/turret/lifecycle.ts` subscribes to Better Auth session identity for both
React and Astro. Identity changes stop capture and clear correlation synchronously;
stale imports and initialization responses cannot restart it. Astro subscribes
without importing React or the router, using Better Auth's cross-tab and focus
refresh behavior.
A signed Turret session outlives a blocked or stopped recorder, preserving errors,
feedback, and request correlation. Identity changes abort recording and end that
session. Turret query options own their RPC calls and cache behavior together;
the replay loader owns its validated chunk reads.

Authentication return URLs use the router's public location and configured base path;
login accepts only same-origin destinations within that mount. Feature flag patches
use validators without defaults; defaults belong to stored configuration alone.

Turret's replay and issue search schemas own destination defaults. Navigation uses
empty search input for a default view and specifies only deliberate overrides.
Preset types, URL validation, and buttons share their feature's preset declaration.
Issue list and detail retain separate default windows.

The SPA mount is declared in `react-app/mount.ts`, shared by the router and invitation
links. Startup scrubs invitation fragments before router construction; it does not
import the router to discover the mount. Moving the SPA also requires moving its
Astro page entry to the corresponding filesystem route.

`contracts/turret.ts` owns feedback input validation and normalization. The form
uses its message and contact bounds, and both submission and HTTP ingest validate
with it before persistence. Long page URLs are shortened without rejecting feedback.
`contracts/turret-correlation.ts` owns correlation header encoding and decoding.
The Worker takes one correlation snapshot at request entry for logs, breadcrumbs,
and errors. Invalid timestamps fall back to that request's entry time.

Caller-supplied request IDs are correlation metadata. Replay spans reference the
server-generated breadcrumb ID, and readers group by that identity. Migration
`0009_span_breadcrumb_identity` discards old diagnostic spans and requires the new
relationship; it provides no compatibility reader or historical backfill.
`worker/observability/route-label.ts` produces route labels from Hono's declared
endpoints, with bounded labels for unmatched requests and Astro. Raw request paths
cannot be supplied to operational metrics.
`bindings/d1/literal-search.ts` owns SQLite literal-substring search, including
pattern escaping and the SQL escape declaration. Use it for comparable searches.
