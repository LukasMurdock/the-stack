# Optional aliases: every recipe runs a package.json script, so `pnpm <script>`
# works without just installed. CI does not use this file.
set shell := ["bash", "-cu"]

default:
    @just --list

setup:
    pnpm install
    pnpm local:setup

secret-auth:
    pnpm secret

dev:
    pnpm dev

doctor:
    pnpm doctor

status:
    pnpm status

cf-typegen:
    pnpm cf:typegen

migrate:
    pnpm db:local:migrate

studio-core:
    pnpm db:studio:core

studio-turret:
    pnpm db:studio:turret

admin-create:
    pnpm admin:create

check-fast:
    pnpm run lint && pnpm test

check-full:
    pnpm verify

format:
    pnpm format

format-check:
    pnpm format:check

seed:
    pnpm local:seed

reset:
    pnpm local:reset

deploy:
    pnpm run deploy

logs:
    pnpm logs

routes:
    pnpm routes

db-generate-core name:
    pnpm db:core:generate --name {{ name }}

new-route path:
    pnpm routes:new {{ path }}
