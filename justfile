set shell := ["bash", "-cu"]

default:
    @just --list

setup:
    npm install
    node scripts/setup-local.mjs

secret-auth:
    npx @better-auth/cli@latest secret

dev:
    astro dev

doctor:
    node scripts/dev-doctor.mjs

status:
    node scripts/dev-status.mjs

cf-typegen:
    npx wrangler types

migrate-core:
    npx wrangler d1 migrations apply CORE_DB --local

migrate-turret:
    npx wrangler d1 migrations apply TURRET_DB --local

studio-core:
    npx wrangler d1 migrations apply CORE_DB --local && DRIZZLE_DB_PATH=$(node scripts/find-d1-sqlite.mjs core_users) node scripts/drizzle-studio-core-local.mjs

studio-turret:
    npx wrangler d1 migrations apply TURRET_DB --local && DRIZZLE_DB_PATH=$(node scripts/find-d1-sqlite.mjs turret_sessions) node scripts/drizzle-studio-turret-local.mjs

admin-create:
    npx wrangler d1 migrations apply CORE_DB --local && node scripts/create-admin-local.mjs

check-fast:
    npx tsx --test "tests/**/*.test.ts"

check-full:
    npx tsx --test "tests/**/*.test.ts" && npx astro build && npx tsc -b

format:
    npx oxfmt --write .

format-check:
    npx oxfmt --check .

seed:
    node scripts/seed-local.mjs

reset:
    node scripts/reset-local.mjs

preflight:
    node scripts/deploy-preflight.mjs

deploy-production:
    npx tsc -b && npx astro build && npx wrangler deploy --config wrangler.json --env production

logs:
    npx wrangler tail --env production

db-generate-core name:
    drizzle-kit generate --config src/bindings/d1/core/drizzle.config.ts --name {{ name }}

new-api name:
    node scripts/new-api.mjs {{ name }}

new-route path:
    node scripts/new-route.mjs {{ path }}
