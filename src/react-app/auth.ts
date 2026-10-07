import { redirect, type ParsedLocation } from "@tanstack/react-router";
import { createAuthClient } from "better-auth/react";
import { adminClient } from "better-auth/client/plugins";

const authClient = createAuthClient({
	plugins: [adminClient()],
});

export { authClient };

type Location = Pick<ParsedLocation, "publicHref">;
type RequireUserOptions = { location: Location };
export async function requireUser({ location }: RequireUserOptions) {
	const { data, error } = await authClient.getSession();
	if (error)
		throw new Error(
			error.message ?? "Could not check your session. Try again."
		);
	if (!data?.user)
		throw redirect({
			to: "/login",
			search: { redirect: location.publicHref.split("#")[0] },
			replace: true,
		});
	return { userId: data.user.id };
}

// A return URL must stay within this router's mount, including its path boundary.
export function safeRedirectTarget(
	href: string | undefined,
	basepath: string,
	origin: string
): string | null {
	if (!href) return null;
	try {
		const url = new URL(href, origin);
		if (url.origin !== origin || url.pathname.startsWith("//")) return null;
		const mount = basepath.replace(/\/$/, "");
		if (
			mount &&
			url.pathname !== mount &&
			!url.pathname.startsWith(`${mount}/`)
		)
			return null;
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return null;
	}
}
