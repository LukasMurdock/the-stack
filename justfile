set shell := ["bash", "-cu"]

default:
    @just --list

setup:
    pnpm install
    pnpm local:setup

secret-auth:
    node -e 'console.log(require("node:crypto").randomBytes(32).toString("base64url"))'

dev:
    pnpm dev

doctor:
    pnpm doctor

status:
    pnpm status

cf-typegen:
    pnpm exec wrangler types

migrate-core:
    pnpm exec wrangler d1 migrations apply CORE_DB --local

migrate-turret:
    pnpm exec wrangler d1 migrations apply TURRET_DB --local

studio-core:
    pnpm exec wrangler d1 migrations apply CORE_DB --local && DRIZZLE_DB_PATH=$(node scripts/find-d1-sqlite.mjs core_users) node scripts/drizzle-studio-core-local.mjs

studio-turret:
    pnpm exec wrangler d1 migrations apply TURRET_DB --local && DRIZZLE_DB_PATH=$(node scripts/find-d1-sqlite.mjs turret_sessions) node scripts/drizzle-studio-turret-local.mjs

admin-create:
    pnpm exec wrangler d1 migrations apply CORE_DB --local && node scripts/create-admin-local.mjs

check-fast:
    pnpm run lint && pnpm test

check-full:
    pnpm verify

format:
    pnpm exec oxfmt --write .

format-check:
    pnpm exec oxfmt --check .

seed:
    node scripts/seed-local.mjs

reset:
    node scripts/reset-local.mjs

preflight:
    node scripts/deploy-preflight.mjs

deploy-production:
    CLOUDFLARE_ENV=production pnpm run build && pnpm exec wrangler deploy --config dist/server/wrangler.json

logs:
    pnpm exec wrangler tail --env production

db-generate-core name:
    pnpm exec drizzle-kit generate --config src/bindings/d1/core/drizzle.config.ts --name {{ name }}

new-route path:
    node scripts/new-route.mjs {{ path }}
