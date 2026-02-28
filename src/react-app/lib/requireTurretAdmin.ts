import type { QueryClient } from "@tanstack/react-query";
import { isRedirect, redirect } from "@tanstack/react-router";

import { authClient } from "./authClient";
import { ApiError } from "./apiClient";
import { turretHealthQueryOptions } from "../queries/turretQueries";

type RequireTurretAdminOpts = {
	context: {
		queryClient: QueryClient;
	};
	location: {
		href: string;
	};
};

function getUserFromSessionResponse(res: unknown): unknown | null {
	if (!res || typeof res !== "object") return null;
	if (!("data" in res)) return null;
	const data = (res as { data?: unknown }).data;
	if (!data || typeof data !== "object") return null;
	if (!("user" in data)) return null;
	return (data as { user?: unknown }).user ?? null;
}

function redirectToLogin(currentHref: string): never {
	throw redirect({
		to: "/login",
		search: {
			redirect: currentHref,
		},
		replace: true,
	});
}

async function requireTurretAdmin({
	context,
	location,
}: RequireTurretAdminOpts) {
	// 1) Signed-in check
	let user: unknown;
	try {
		const res = await (
			authClient as unknown as { getSession: () => Promise<unknown> }
		).getSession();
		user = getUserFromSessionResponse(res);
	} catch (err) {
		if (isRedirect(err)) throw err;
		redirectToLogin(location.href);
	}

	if (!user) {
		redirectToLogin(location.href);
	}

	// 2) Admin check (server-authoritative)
	try {
		await context.queryClient.ensureQueryData(turretHealthQueryOptions);
	} catch (err) {
		if (isRedirect(err)) throw err;

		if (err instanceof ApiError) {
			// 401: not signed in, 403: not admin
			if (err.status === 401 || err.status === 403) {
				redirectToLogin(location.href);
			}
		}

		throw err;
	}
}

export { requireTurretAdmin };
