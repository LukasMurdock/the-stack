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
just admin-create
```

This promotes `ADMIN_EMAIL` and creates a local credential if missing.

## Runtime verification

```bash
curl -s "http://localhost:4321/api/health"
```

Check `auth.signupMode` and `auth.selfSignUpEnabled` in the response.
