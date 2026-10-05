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
	try {
		const { data, error } = await authClient.getSession();
		if (error || !data?.user) redirectToLogin(location.href);
	} catch (err) {
		if (isRedirect(err)) throw err;
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
