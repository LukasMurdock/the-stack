import type { MiddlewareHandler } from "hono";
import type { Bindings } from "../../../index";
import { createAuth } from "../../../auth";

function isAdminRole(role: unknown): boolean {
	if (!role || typeof role !== "string") return false;
	return role
		.split(",")
		.map((value) => value.trim())
		.some((value) => value === "admin");
}

const requireInternalTurretAdmin: MiddlewareHandler<{
	Bindings: Bindings;
}> = async (c, next) => {
	const env = c.env;
	const auth = createAuth(env, c.executionCtx);
	const session = await auth.api.getSession({ headers: c.req.raw.headers });

	if (!session?.user) {
		return c.json({ error: "Unauthorized" }, 401);
	}

	const user = session.user;
	if (!isAdminRole(user.role)) {
		return c.json({ error: "Forbidden" }, 403);
	}

	await next();
};

export { isAdminRole, requireInternalTurretAdmin };
