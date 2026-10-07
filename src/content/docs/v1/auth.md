---
title: "Auth Guide"
description: "Configure signup policy and admin bootstrap flows."
pubDate: "2026-02-27"
---

# Auth Guide

## Environment knobs

- `AUTH_SIGNUP_MODE=invite_only` (default): no public self-signup.
- `AUTH_SIGNUP_MODE=open`: allow public self-signup.
- `BOOTSTRAP_SECRET`: required for `/api/internal/bootstrap-admin`.

## Local admin bootstrap

```bash
pnpm exec wrangler d1 migrations apply CORE_DB --local
node scripts/create-admin-local.mjs
```

This promotes `ADMIN_EMAIL` and creates a local credential if missing.

## Runtime verification

```bash
curl -s "http://localhost:4321/api/health"
```

Check `auth.signupMode` and `auth.selfSignUpEnabled` in the response.

## Email delivery

Production uses Cloudflare Email Sending through the `EMAIL` binding. Set `EMAIL_FROM` to a mailbox on your onboarded domain and configure `EMAIL_FROM_NAME` for your product. Local development defaults to `EMAIL_TRANSPORT=log`, prints local auth links, and sends nothing.

For the optional Resend transport, set `EMAIL_TRANSPORT=resend` and provide `RESEND_API_KEY`; credentials alone do not select a transport. Production log-only mode and missing provider configuration produce observable failures. See `docs/email.md` for setup, preview/privacy settings, and acceptance checks.
