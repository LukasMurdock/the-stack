# Auth storage migration to Better Auth 1.7

Better Auth 1.7 requires atomic `increment` and `getAndDelete` operations.
The Worker now stores temporary auth data in `CORE_DB.auth_storage`, using
single-statement SQL updates and `DELETE ... RETURNING`. D1 queries use the
primary without a read-replication session, so revocations are visible to the next
request. Expired records are rejected immediately and removed by the hourly cron.
Users, passwords, linked Google accounts, and their existing schema stay unchanged.
`CORE_KV` still stores admin bootstrap markers.

## Local cutover

Stop the development server before transferring existing auth records:

```bash
pnpm exec wrangler d1 migrations apply CORE_DB --local
node scripts/migrate-auth-storage.mjs --local --writes-paused
just dev
```

The transfer preserves keys, values, and absolute expiration times. This includes
active sessions, per-user session lists, verification records, and counters. It
skips expired records and `bootstrap:` markers. Existing D1 keys are retained,
allowing retries while traffic remains paused. KV records are left unchanged.
The local Wrangler list is limited to one page; the command rejects 1,000 or more
local keys rather than silently transferring an incomplete dataset. Remote lists
use Wrangler's pagination.

## Production cutover

Configure the real production `CORE_DB.database_id` and `CORE_KV.id` in
`wrangler.json` first; this template ships placeholders. Keep the same
`BETTER_AUTH_SECRET` so existing signed session cookies remain valid.

1. Back up D1 and record the current deployment version.
2. Block application traffic, including auth-protected API routes that can refresh
   sessions. Stop other Workers or jobs writing auth keys. Drain in-flight requests
   and allow at least 60 seconds after the last KV write for propagation (longer
   if the previous deployment used a longer KV cache TTL).
3. Check for duplicate account identities:

    ```bash
    pnpm exec wrangler d1 execute CORE_DB --remote --env production --command "SELECT provider_id, account_id, count(*) FROM auth_account GROUP BY provider_id, account_id HAVING count(*) > 1"
    ```

    Resolve any duplicates before upgrading; the built-in Google and credential
    providers retain their existing account identities in Better Auth 1.7.7.

4. Apply the migration and transfer KV records with traffic still blocked:

    ```bash
    pnpm exec wrangler d1 migrations apply CORE_DB --remote --env production
    node scripts/migrate-auth-storage.mjs --remote --env production --writes-paused
    ```

5. Deploy the upgraded Worker with `just deploy-production`, then verify an
   existing session, email/password sign-in, Google sign-in if configured, password
   reset, and sign-out/revocation before reopening traffic.

The transfer command does not deploy the Worker or toggle maintenance mode.
`--writes-paused` asserts that the operator has already stopped traffic. Its SQL
batches are stored in a private temporary directory, with file permissions `0600`,
and deleted on exit. Values are not printed. Failed transfers can be rerun before
cutover while traffic remains paused.

## After cutover and rollback

Never rerun the KV transfer once the new Worker has accepted traffic: old KV
records could restore a consumed token or a revoked session. There is no runtime
KV fallback for the same reason. Keep KV for bootstrap markers; stale auth records
can be removed separately after their retention window.

If the upgraded library must be rolled back, retain the D1 storage adapter and
table in the rollback build. Redeploying the previous KV-backed Worker after
cutover would use stale auth data. Reverting storage requires a new paused,
reverse transfer from the current D1 data, not a replay of the old KV snapshot.

See the [Better Auth 1.7 upgrade guide](https://better-auth.com/docs/guides/1-7-upgrade-guide)
for the upstream storage contract and account compatibility requirements.
