import { isRedirect, redirect } from "@tanstack/react-router";

import { authClient } from "./authClient";

type RequireCoreAdminOpts = {
	location: {
		href: string;
	};
};

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
	try {
		const { data, error } = await authClient.getSession();
		if (error || !data?.user) redirectToLogin(location.href);
	} catch (err) {
		if (isRedirect(err)) throw err;
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
