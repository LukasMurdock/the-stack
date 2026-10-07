# Test portfolio

Before adding a test, identify the behavioral claim and search existing tests for
that claim. Strengthen or consolidate an existing test when it can detect the
same failure. State the unique failure a new test protects in the change summary.
Test count and coverage percentage are not goals.

Keep permutations at the cheapest layer that can establish the behavior:

- Shared query bounds belong in `unit/turret-query-contracts.test.ts`; HTTP tests
  verify each route attaches validation and rejects input before storage.
- Domain authorization, tenant isolation, transactions, and retries belong in
  integration tests over the migrated SQLite D1 adapter.
- Turret admin authorization belongs in the registered-route check in
  `integration/turret-settings.test.ts`. Do not duplicate its method/path matrix
  inside unrelated feature tests.
- Browser tests protect actual UI, compiled imports, cross-tab lifecycle, native
  browser behavior, and real Worker bindings. Set up unrelated preconditions
  through HTTP. Do not repeat a complete recovery workflow for every failure
  cause when a representative workflow plus cause-specific checks suffices.
- Tooling probes share the batched Oxlint invocation in `tooling/lint.test.ts`.
  Assert diagnostics by filename so one probe cannot satisfy another's claim.

Use complete migrations for database integration fixtures. Keep real Worker/D1/R2
round trips even when their source coverage overlaps fixtures. This template
supports fresh instances; do not add populated legacy-state migration fixtures
without an explicit requirement to support that upgrade path.

Mock external boundaries, not business modules. Do not add production indirection
solely to relocate a test. Review reported test durations and subprocess count
when changing expensive fixtures. Verify a proposed deletion against retained
claims; targeted fault injection can demonstrate that the remaining test still
fails for the relevant regression.
