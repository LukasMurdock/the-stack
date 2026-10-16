# First deployment

Follow [Deploy a new app with Void](DEPLOYMENT_GUIDE.md).

Choose your app name, origin, administrator, and sender in
`config/cloudflare.mjs`. Connect your Cloudflare account, set your app secrets,
then run:

```bash
pnpm verify
pnpm run deploy
```

Void provisions two separate D1 databases, two KV namespaces, and an R2 replay
bucket. Each D1 keeps its own migrations and storage limits. Do not manually
create resources or paste their IDs into the starter. Commit the generated
`void.lock.json` so later deployments reuse the resources.

Void also sets up your configured email sender domain after reviewing the DNS
changes. Analytics datasets appear on first write. Account access, a sender domain
you own, and any required Cloudflare product eligibility still belong to app setup.
