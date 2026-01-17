# One-Time Production Setup (Greenfield)

### 1) Choose Names

Pick stable names up front:

- Worker script name: `the-stack-production` (already set in `wrangler.json` under `env.production.name`)
- D1 database name: `core-d1-production`
- KV namespace(s): e.g. `core-kv-production`
- R2 bucket(s): e.g. `core-bucket-production`
- Queue(s): e.g. `core-queue-production`
- Durable Object class names: should be stable once deployed (migration-sensitive)

### 2) Configure the Production Route

This repo assumes you are using a custom domain route.

In `wrangler.json`, configure the production route under `env.production` (and only there).
Using only a production route reduces the chance an accidental deploy affects production.

Typical patterns:

- `api.example.com/*` on zone `example.com`

### 3) Provision Production Resources

Provision resources with Wrangler CLI, then copy the resulting IDs/names into `wrangler.json` under `env.production`.

#### D1

Create:

```bash
npx wrangler d1 create core-production
```

- Copy the returned `database_id` into `wrangler.json` -> `env.production.d1_databases[0].database_id`.
- Keep `migrations_dir` pointing at the repo migrations directory.

Migrations (recommended workflow):

```bash
# Apply locally first
npm run db:core:migrate:local

# Apply to production (remote)
npx wrangler d1 migrations apply CORE_DB --remote --env production
```

Notes:

- Always use prepared statements with `bind()` for user input.
- Prefer expand/contract migrations (see “Never Take Down Production”).

#### KV

Create:

```bash
npx wrangler kv namespace create core-kv-production
```

- Copy the returned namespace id into `wrangler.json` -> `env.production.kv_namespaces`.

KV gotcha:

- KV is eventually consistent globally (often up to ~60s). Do not rely on global read-after-write.

#### R2

Create:

```bash
npx wrangler r2 bucket create core-bucket-production
```

- Copy the bucket name into `wrangler.json` -> `env.production.r2_buckets`.

R2 gotcha:

- Prefer immutable keys (write new keys, then repoint references) for deploy-safe changes.

#### Queues

Create:

```bash
npx wrangler queues create core-queue-production
```

- Configure the producer/consumer bindings in `wrangler.json` under `env.production.queues`.

Operational requirements:

- Queue delivery is at-least-once: consumers must be idempotent.
- Prefer versioned message payloads (e.g. `type: "v1" | "v2"`) for safe rollouts.

#### Durable Objects

Durable Objects are configured via `wrangler.json` bindings + migrations.

Rules:

- Treat DO migrations as one-way.
- Never use `deleted_classes` unless you intend to permanently delete all DO data.
- Keep migration tags unique and sequential.

Before a production deploy that includes migration changes:

```bash
npx wrangler deploy --config wrangler.json --env production --dry-run
```

### 4) Set Production Secrets

Store secrets via Wrangler (never commit them):

```bash
npx wrangler secret put SOME_SECRET --env production
npx wrangler secret list --env production
```
