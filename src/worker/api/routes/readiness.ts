import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Bindings } from "../../index";
import {
	EMAIL_DEPENDENT_FEATURES,
	describeEmailDelivery,
	type EmailDelivery,
} from "../../../contracts/email-delivery";
import { flagBindingStatus } from "../../flags";
import { missingRequiredSecrets } from "../../secrets";

const app = new OpenAPIHono<{ Bindings: Bindings }>();
// Email is optional for readiness: without it the app serves, but the listed
// features cannot work. Reporting it here tells the owner before a user does.
const emailStatus = z.discriminatedUnion("delivery", [
	z.object({
		delivery: z.literal("provider"),
		transport: z.enum(["cloudflare", "resend"]),
	}),
	z.object({ delivery: z.literal("log_only") }),
	z.object({
		delivery: z.literal("unavailable"),
		reason: z.string(),
		disabled: z.array(z.enum(EMAIL_DEPENDENT_FEATURES)),
	}),
]);
// Flags are optional too: without the FLAGS binding every flag serves its
// registry default.
const flagsStatus = z.discriminatedUnion("binding", [
	z.object({ binding: z.literal("configured") }),
	z.object({
		binding: z.literal("missing"),
		serving: z.literal("defaults"),
	}),
]);
// Required secrets with no valid value (names only). Any makes the app not
// ready: sign-in cannot work without BETTER_AUTH_SECRET.
const secretsStatus = z.object({
	missingRequired: z.array(z.string()),
});
const ready = z.object({
	ok: z.boolean(),
	email: emailStatus,
	flags: flagsStatus,
	secrets: secretsStatus,
});
const getReadiness = createRoute({
	method: "get",
	path: "/readiness",
	responses: {
		200: {
			description: "Required database schema is available",
			content: { "application/json": { schema: ready } },
		},
		503: {
			description: "Application is not ready",
			content: { "application/json": { schema: ready } },
		},
	},
});

export function emailReadiness(env: Bindings): z.infer<typeof emailStatus> {
	const delivery: EmailDelivery = describeEmailDelivery({
		appEnv: env.APP_ENV,
		transport: env.EMAIL_TRANSPORT,
		sender: env.EMAIL_FROM,
		sendEmailBinding: env.SEND_EMAIL ? "present" : "absent",
		resendApiKey: env.RESEND_API_KEY?.trim() ? "present" : "absent",
	});
	if (delivery.delivery === "unavailable")
		return { ...delivery, disabled: [...EMAIL_DEPENDENT_FEATURES] };
	return delivery;
}

export const routes = app.openapi(getReadiness, async (c) => {
	c.header("Cache-Control", "no-store");
	const email = emailReadiness(c.env);
	const flags = flagBindingStatus(c.env.FLAGS);
	const secrets = { missingRequired: [...missingRequiredSecrets(c.env)] };
	if (secrets.missingRequired.length > 0)
		return c.json({ ok: false, email, flags, secrets }, 503);
	try {
		// Compile a query over required application columns without reading user
		// data. A live binding alone does not prove migrations were applied.
		await c.env.CORE_DB.prepare(`select o.name, m.role, i.acceptance_key, u.email_verified, s.expires_at, a.expires_at
 from organizations o
 left join memberships m on m.organization_id = o.id
 left join invitations i on i.organization_id = o.id
 left join auth_user u on u.id = m.user_id
 left join auth_session s on s.user_id = u.id
 left join auth_storage a on a.key = s.token
 where 0`).all();
		return c.json({ ok: true, email, flags, secrets }, 200);
	} catch {
		return c.json({ ok: false, email, flags, secrets }, 503);
	}
});
