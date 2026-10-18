---
title: "Auth Guide"
description: "Configure signup policy and admin bootstrap flows."
pubDate: "2026-02-27"
---

# Auth Guide

## Environment knobs

- `AUTH_SIGNUP_MODE=invite_only` (default): no public self-signup.
- `AUTH_SIGNUP_MODE=open`: allow public self-signup.
- `BOOTSTRAP_SECRET`: required for `/api/internal/bootstrap-admin`, which
  `pnpm admin:bootstrap` calls to create the first production administrator
  and print its password once.

## Adding people without email

Admin → Users → Create user makes an account with a server-generated starting
password, shown once to the administrator (`POST /api/internal/users`,
administrators only). "Mark email as verified" lets the person accept
invitations without a verification email.

Signed-in people change their password at `/app/account` (Better Auth
`changePassword`, optionally signing out their other sessions), so a starting
password does not have to stay. An account without a password (Google only)
can request an emailed link there to set one.

With email working, Admin → Users → ⋯ (or the user's page) → Send sign-in link
(`POST /api/internal/users/{userId}/sign-in-link`, administrators only) emails
someone Better Auth's one-hour, single-use reset link in a "Set your password"
email, for an account whose owner knows no password (a lost starting password,
an imported account). One link per person per 60 seconds (429 with
`Retry-After`), refused for banned users (409) and when email is not configured
(503), and audited as `admin.sign_in_link_sent` with ids only. The public
password-reset request cannot choose this email.

## Local admin bootstrap

```bash
pnpm db:local:migrate
node scripts/create-admin-local.mjs
```

This promotes `ADMIN_EMAIL` and creates a local credential if missing.

## Runtime verification

```bash
curl -s "http://localhost:4321/api/health"
```

Check `auth.signupMode` and `auth.selfSignUpEnabled` in the response.

## Email delivery

Production uses Cloudflare Email Sending through the `SEND_EMAIL` binding. Set `EMAIL_FROM` to a mailbox on your onboarded domain and configure `EMAIL_FROM_NAME` for your product. Local development defaults to `EMAIL_TRANSPORT=log`, prints local auth links, and sends nothing.

For the optional Resend transport, set `EMAIL_TRANSPORT=resend` and provide `RESEND_API_KEY`; credentials alone do not select a transport. Production log-only mode and missing provider configuration produce observable failures. See `docs/email.md` for setup, preview/privacy settings, and acceptance checks.

Cloudflare Email Sending only sends from a domain onboarded for it (`pnpm exec void email status --platform cloudflare`); any other sender fails every send, for example `email sending not authorized for subdomain`. Auth responses stay the same either way (no account enumeration), so the outcome of the last real send is kept in `CORE_KV`: `GET /api/readiness` reports `email.lastSend` (`outcome`, `atMs`, `code`) without failing readiness, `pnpm ship` warns after deploying while it is `failed`, and every admin page shows a banner with the sanitized provider message until the next send is accepted.
