// A host the app used to be served on keeps answering (links in sent email,
// bookmarks, stored file URLs) but redirects to APP_URL: sign-in cookies and
// the same-origin checks on writes belong to APP_URL's origin, so the app does
// not work on any other. GET and HEAD move permanently (301); other methods
// keep their method and body (308).

export function redirectToAppUrl(
	request: Request,
	env: { APP_URL?: string; APP_REDIRECT_HOSTS?: string }
): Response | null {
	if (!env.APP_URL || !env.APP_REDIRECT_HOSTS) return null;
	const url = new URL(request.url);
	const hosts = env.APP_REDIRECT_HOSTS.split(",").map((host) =>
		host.trim().toLowerCase()
	);
	if (!hosts.includes(url.hostname)) return null;
	const target = new URL(url.pathname + url.search, env.APP_URL);
	if (target.host === url.host) return null;
	const status = ["GET", "HEAD"].includes(request.method) ? 301 : 308;
	return new Response(null, {
		status,
		headers: { location: target.href, "cache-control": "no-store" },
	});
}
