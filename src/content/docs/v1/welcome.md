---
title: "Getting Started"
description: "Go from a fresh clone to your first persisted product record."
pubDate: "2026-10-07"
---

# Getting Started

Start with a working local app, then change one feature. You need Node.js
22.22.1+ and pnpm 10.34.6. A Cloudflare account, email provider, OAuth credentials,
and `just` are not needed for this local walkthrough.

## 1. Get the starter

Use GitHub's **Use this template** action to create your own repository, then
clone it. To try this repository directly instead:

```bash
git clone https://github.com/LukasMurdock/the-stack.git my-product
cd my-product
```

Check Node and install the package manager version declared in `package.json`:

```bash
node --version
npm install --global pnpm@10.34.6
pnpm --version
```

If you already have that pnpm version, skip installation.

## 2. Initialize local development

```bash
pnpm install
pnpm local:setup
pnpm dev
```

`pnpm local:setup` creates `.dev.vars` from the example when absent and generates
`BETTER_AUTH_SECRET` if it is missing, empty, or `replace-me`. Existing configured
secrets and other settings are preserved. The local secret comes from `.dev.vars`;
exporting a shell variable does not replace it during setup.

Setup applies both local D1 migration chains and creates a verified administrator.
It ends with `Local setup complete.`, app URLs, and the credential-file location.
Rerunning setup preserves records and an existing administrator password.
The dev server runs at <http://localhost:4321>.

If your coding agent starts Astro in the background, use
`pnpm exec astro dev logs --follow` to read server output and local auth links.
Use `pnpm exec astro dev stop` to stop that background server.

Local defaults, including `APP_URL` and `ADMIN_EMAIL=admin@localhost.test`, live in
`wrangler.json` vars. To choose another local admin email, add `ADMIN_EMAIL` to
`.dev.vars` before setup. Optional credentials are empty by default. Local email
is log-only: auth verification and recovery links appear in the dev terminal.

## 3. Sign in and create a record

In a second terminal, read your local login credentials:

```bash
cat .wrangler/.admin-password
```

1. Open <http://localhost:4321/app/organizations>. The app redirects to sign-in
   and returns here after login.
2. Sign in using the `email` and `password` from the JSON file. Use **Sign in**;
   public signup is disabled by default.
3. Enter **My product** as the organization name and select **Create organization**.
4. Open **My product**, then select **Projects**.
5. Enter **Launch pilot** and a description, then select **Create project**.
6. Refresh. The project and description remain because they are stored in local D1.

Creating an organization makes you its owner. Platform administrator privileges
control the admin area; they do not bypass organization membership. Owners and
editors can create projects; viewers can read them. An organization can represent
your own workspace even when you are building alone.

Optional: open **Invitations**, invite a second email as a viewer, and open the
invitation link in another browser profile. New invited users register and verify
email before joining. Find the verification link in the dev-server terminal;
local development sends no real email.

## 4. Verify the app

```bash
curl -i http://localhost:4321/api/health
pnpm doctor
pnpm status
```

Health should return `200` with `"ok": true`. The API reference is at
<http://localhost:4321/api/scalar>. Without optional credentials, Google sign-in
is unavailable and Turret ingestion falls back to basic mode. The product remains
usable; configure replay later if you need it.

## 5. Build your first feature

Follow [Build your first feature](/docs/v1/first-feature/) to add project status
through a database migration, shared validation, the permission-protected operation,
typed API, query cache, and React form. The starter intentionally ships the
smaller create/list example; you make the change yourself.

Use the [extension reference](/docs/v1/extend/) for architecture and replacement
boundaries, [auth guide](/docs/v1/auth/) for onboarding policy, and
[database guide](/docs/v1/database/) for migration workflows.

## Troubleshooting

| Symptom                                    | Action                                                                                                                                                                |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm` not found                           | Install pnpm using the command above.                                                                                                                                 |
| Missing dependency or Wrangler unavailable | Run `pnpm install`, then `pnpm local:setup`.                                                                                                                          |
| An optional key still equals `replace-me`  | Set that key to `""` in `.dev.vars` to disable it, then rerun setup.                                                                                                  |
| Can't find the initial password            | Read `.wrangler/.admin-password`; if it was lost, run `node scripts/create-admin-local.mjs --force-reset-password` to deliberately replace this local admin password. |
| No signup button                           | Invite-only mode is the default. Use the setup administrator; invitations support new users.                                                                          |
| Verification email never arrives           | Read the link in the dev-server terminal; email is log-only locally.                                                                                                  |
| Port 4321 is occupied                      | Stop the other server, or change `APP_URL` in `.dev.vars` and run `pnpm dev --port <matching-port>`.                                                                  |

`pnpm doctor` diagnoses configuration; `pnpm status` prints useful URLs.
`just` is an optional maintenance shortcut. `just seed` fills observability demo
records, rather than organizations or projects, and is not part of this walkthrough.

When your local feature works, follow the [deployment runbook](/docs/v1/deploy-runbook/).
Production requires your own Cloudflare resources, secrets, origin, and email sender.
