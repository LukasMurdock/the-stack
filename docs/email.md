# Email setup and operations

The Stack sends verification and password-reset emails using React Email templates. Production defaults to Cloudflare Email Sending through the native `EMAIL` binding. Resend is an explicit alternative; local development defaults to logging without sending.

## Transport settings

| Setting           | Purpose                                       |
| ----------------- | --------------------------------------------- |
| `EMAIL_TRANSPORT` | `cloudflare`, `resend`, or local-only `log`   |
| `EMAIL_FROM`      | Sender mailbox, such as `noreply@example.com` |
| `EMAIL_FROM_NAME` | Optional sender display name                  |
| `EMAIL`           | Cloudflare `send_email` binding               |
| `RESEND_API_KEY`  | Secret required only when selecting Resend    |

Set non-sensitive values in `wrangler.json`: local defaults under `vars`, production values under `env.production.vars`. Existing single-mailbox `EMAIL_FROM` values such as `Example <noreply@example.com>` remain supported; prefer separate mailbox/name settings for new projects.

If `EMAIL_TRANSPORT` is omitted, local/dev/test environments use `log` and other environments use `cloudflare`. Invalid settings, missing provider configuration, and production log mode fail with `E_EMAIL_CONFIGURATION`. Having a Resend key does not select Resend automatically. There is no automatic provider fallback or application retry: an uncertain send result could otherwise create duplicate auth emails.

## Cloudflare production setup

Cloudflare Email Sending requires Cloudflare DNS, an onboarded sending domain, and Workers Paid for arbitrary recipients. Verified account destinations have different eligibility and quota rules. Check current [pricing](https://developers.cloudflare.com/email-service/platform/pricing/) and [sending limits](https://developers.cloudflare.com/email-service/platform/limits/) for your project. Email Sending is currently beta and intended for transactional messages. [Getting started](https://developers.cloudflare.com/email-service/get-started/send-emails/), [FAQ](https://developers.cloudflare.com/email-service/reference/faq/)

1. In Cloudflare, open Compute → Email Service → Email Sending and onboard your sending domain. Review the DNS changes, including SPF, DKIM, and DMARC, alongside any existing mail services. Outbound sending does not require moving your inbound mailbox provider. [Domain configuration](https://developers.cloudflare.com/email-service/configuration/domains/)
2. Set `env.production.vars.EMAIL_FROM` to a mailbox on the onboarded domain and set `EMAIL_FROM_NAME` to your product name.
3. Keep `EMAIL_TRANSPORT=cloudflare` and the production binding:

    ```jsonc
    "send_email": [{ "name": "EMAIL" }]
    ```

    For a project-specific sender restriction, add `allowed_sender_addresses` containing your sender mailbox. Avoid restricting destinations to a fixed account address when sending user auth mail. [Binding configuration](https://developers.cloudflare.com/email-service/configuration/send-bindings/)

4. Review the domain's Email preview setting. Cloudflare enables previews for new sending domains; they can include verification/reset links. Disable previews if your policy excludes storing auth email bodies in provider dashboards. [Email logs](https://developers.cloudflare.com/email-service/observability/logs/)
5. Run the existing [deployment workflow](DEPLOYMENT_GUIDE.md), then complete the acceptance checks below. The Workers binding uses account capabilities; it does not require a Cloudflare API token secret in this application. [Workers API](https://developers.cloudflare.com/email-service/api/send-emails/workers-api/)

## Local development

The checked-in local configuration uses `EMAIL_TRANSPORT=log`. The app emits `email.log_only` metadata and prints local verification/reset URLs so you can complete auth flows without a sending domain. Real credentials do not override this selection. Auth URLs are never printed in deployed environments.

To exercise the native binding locally, set `EMAIL_TRANSPORT=cloudflare` in `.dev.vars`. The included local `EMAIL` binding simulates delivery. The Astro adapter disables remote bindings, so this does not send real Cloudflare email. Use the deployed staging Worker for real delivery checks. Cloudflare also supports explicit remote development bindings, but enabling them requires deliberately changing this starter's remote-binding configuration. [Local simulation](https://developers.cloudflare.com/email-service/local-development/sending/)

## Optional Resend configuration

Set `EMAIL_TRANSPORT=resend` in the selected environment and provide `RESEND_API_KEY`. Configure the sender domain with Resend and use its authorized sender mailbox in `EMAIL_FROM`.

```bash
pnpm exec wrangler secret put RESEND_API_KEY --env production
```

For real local Resend tests, set both `EMAIL_TRANSPORT=resend` and `RESEND_API_KEY` in `.dev.vars`; this sends actual messages. Existing projects upgrading from the previous key-selected transport must choose `resend` explicitly to keep their delivery provider. Do not remove the old provider's DNS records or credentials until the chosen migration path is verified.

## Logs and failures

Successful submission emits `email.accepted` with provider, message ID, email type, environment, deployment ID, and request ID when available. The `email.send` native span carries matching correlation fields. Acceptance does not establish inbox delivery.

Auth failures emit `email.send_failed` with provider and error code. Cloudflare exceptions preserve their original code and stack; Resend failures returned as data become exceptions. Auth callbacks use `waitUntil` when available, and keep public auth responses independent of delivery outcomes. No email body, auth URL, recipient, or subject is added to acceptance/failure metadata.

Check Cloudflare Email Service activity for delivery and bounce outcomes. Suppression, sender onboarding, daily quota, and rate-limit errors need operational attention; changing providers automatically would obscure those outcomes. Delivery/deferred/bounce/complaint subscriptions through Queues can be added when the project needs application-level delivery tracking. They are separate account configuration and are not provisioned by this starter. [Lifecycle](https://developers.cloudflare.com/email-service/concepts/email-lifecycle/), [Event subscriptions](https://developers.cloudflare.com/email-service/platform/event-subscriptions/)

## Per-project acceptance checks

- [ ] Verify sender authentication and the production transport/binding configuration.
- [ ] Review sending quota and Email preview settings.
- [ ] Send verification and password-reset emails to ordinary recipients outside the account's verified-destination list. Confirm HTML/text rendering, delivery, and working links.
- [ ] Match an accepted message ID in application logs with provider delivery activity.
- [ ] Exercise a controlled staging failure; confirm `email.send_failed`, provider/code, request/deployment correlation, and unchanged public auth responses.
- [ ] Verify local log mode prints usable auth URLs and does not send; confirm deployed logs omit auth links and bodies.
- [ ] Record results and deployment ID in the project's operations notes before completing a provider migration.
