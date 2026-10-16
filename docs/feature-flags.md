# Feature flags

Unfinished work lands on `main` behind a flag that is off by default. Flags are
evaluated by [Cloudflare Flagship](https://developers.cloudflare.com/flagship/)
through the Worker's `FLAGS` binding and stay server-authoritative: the browser
only reads values the Worker evaluated for the signed-in user.

## Declare a flag

Every flag the code reads is declared in `src/contracts/feature-flags.ts`:

```ts
"new-checkout": booleanFlag({
	owner: "payments",
	description: "Serves the redesigned checkout.",
	expires: "2027-03-01",
	exposure: "client", // "server": only Worker code reads it
	default: false, // the existing, safe behavior
}),
```

`stringFlag`, `numberFlag` and `objectFlag` take a zod `schema` that bounds what
Flagship may serve (e.g. `z.enum(["v1", "v2"])`). Keys are kebab-case; reading
an undeclared key is a compile error. A unit test fails `pnpm verify` once a
flag is past `expires` or declared more than a year out: remove the flag and
its dead branch, or extend the date with a reason.

## Read a flag

- Worker: `requestFlags({ binding: env.FLAGS, subject, keys })` in
  `src/worker/flags.ts` evaluates the keys a request needs once, up front.
  The evaluation context is `userId`, `organizationId` and the account `role`,
  each bounded; nothing secret is sent.
- Browser: `useFlag("new-checkout", { userId, organizationId })` from
  `src/react-app/flags.ts` reads `GET /api/flags` (client flags only) and
  returns the registry default while loading and on error.

Every failure (no binding, flag not created yet, wrong type, a value outside
the schema, a binding error) serves the registry default. Misconfigurations are
logged as `flags.default_served`; `/api/readiness` and `pnpm doctor` report
whether the binding is configured.

## Local development and tests

No Cloudflare account is needed. `pnpm local:setup` (or `pnpm flags:local`)
writes each declared flag with its default into the local Flagship store under
`.wrangler/state`; browser tests start from a reset store per run.

```bash
pnpm flags                                   # registry + what the store serves
pnpm flags --user <userId>                   # evaluated for a user
pnpm flags on new-checkout --user <userId>   # on for you only (a targeting rule)
pnpm flags on new-checkout                   # on for everyone locally
pnpm flags off new-checkout
pnpm flags:local --reset                     # back to registry defaults
```

Changes apply to a running `pnpm dev` on its next request. `pnpm flags on`
wraps Wrangler's local store; the equivalent by hand is:

```bash
pnpm exec wrangler flagship flags update the-stack-local new-checkout --local \
	--persist-to .wrangler/state --add-rule 'serve=on; when=userId equals "<userId>"'
```

Your user ID is in Admin → Users. A browser spec turns a flag on with
`node scripts/flags.ts on <key> --organization <id> --e2e`.

## Production

Deploy creates or reuses the Flagship app (see
[Deployment](DEPLOYMENT_GUIDE.md#feature-flags-flagship)). A flag missing from
the app serves its default, so create it when you start rolling out, with
Wrangler (`APP_ID` is in `void.lock.json`) or the dashboard:

```bash
pnpm exec wrangler flagship flags create $APP_ID new-checkout --description "..."
# Target people or organizations first:
pnpm exec wrangler flagship flags update $APP_ID new-checkout \
	--add-rule 'serve=on; when=organizationId in ["<orgId>"]'
# Then a sticky percentage rollout, raised over time:
pnpm exec wrangler flagship flags rollout $APP_ID new-checkout --to on --percentage 10 --by userId
# Kill switch: a disabled flag serves its default variation.
pnpm exec wrangler flagship flags disable $APP_ID new-checkout
```

Changes propagate within about 30 seconds, without a deploy. Once a flag
serves its new value to everyone, make that the code's behavior, delete the
branch and the registry entry, deploy, then delete the flag in Flagship.

Migrations cannot hide behind a flag: they are add-only and expand first, so
the schema must work with the flag both on and off.

Flagship references: [binding methods](https://developers.cloudflare.com/flagship/binding/methods/),
[targeting](https://developers.cloudflare.com/flagship/targeting/),
[percentage rollouts](https://developers.cloudflare.com/flagship/targeting/percentage-rollouts/),
[Wrangler commands](https://developers.cloudflare.com/flagship/reference/wrangler-commands/),
[best practices](https://developers.cloudflare.com/flagship/best-practices/).
