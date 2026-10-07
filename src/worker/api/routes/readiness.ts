import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import type { Bindings } from "../../index";

const app = new OpenAPIHono<{ Bindings: Bindings }>();
const ready = z.object({ ok: z.boolean() });
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
export const routes = app.openapi(getReadiness, async (c) => {
	c.header("Cache-Control", "no-store");
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
		return c.json({ ok: true }, 200);
	} catch {
		return c.json({ ok: false }, 503);
	}
});
