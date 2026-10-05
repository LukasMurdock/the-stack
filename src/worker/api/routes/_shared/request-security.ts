function requiredSameOrigin(
	appUrl: string | undefined,
	req: Request
): string | null {
	if (!appUrl) return "missing_app_url";
	const allowedOrigin = new URL(appUrl).origin;

	const secFetchSite = req.headers.get("Sec-Fetch-Site");
	if (secFetchSite === "cross-site") return "cross_site";

	const origin = req.headers.get("Origin");
	if (origin && origin !== allowedOrigin) return "origin_mismatch";

	return null;
}

function getBearerToken(req: Request): string | null {
	const auth = req.headers.get("Authorization") ?? "";
	const match = auth.match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : null;
}

export { requiredSameOrigin, getBearerToken };
