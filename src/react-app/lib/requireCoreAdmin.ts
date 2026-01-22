import { isRedirect, redirect } from "@tanstack/react-router";

import { authClient } from "./authClient";

type RequireCoreAdminOpts = {
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

async function requireCoreAdmin({ location }: RequireCoreAdminOpts) {
	// 1) Signed-in check
	let user: unknown;
	try {
		const res = await (authClient as unknown as {
			getSession: () => Promise<unknown>;
		}).getSession();
		user = getUserFromSessionResponse(res);
	} catch (err) {
		if (isRedirect(err)) throw err;
		redirectToLogin(location.href);
	}

	if (!user) {
		redirectToLogin(location.href);
	}

	// 2) Admin check (server-authoritative).
	// If a non-admin calls admin endpoints, the server returns 403.
	try {
		const { error } = await authClient.admin.listUsers({
			query: {
				limit: 1,
				offset: 0,
			},
		});
		if (error) {
			redirectToLogin(location.href);
		}
	} catch (err) {
		if (isRedirect(err)) throw err;
		redirectToLogin(location.href);
	}
}

export { requireCoreAdmin };
