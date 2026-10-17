// Astro fingerprints the files it emits under /_astro/, so a URL's content
// never changes and browsers may keep it for a year. Astro's adapter writes
// that rule to dist/client/_headers, but Void deploys Astro with
// `assets.run_worker_first: true` and does not upload _headers, so every
// asset request reaches the Worker and the rule never applies. The Worker
// serves these from ASSETS itself and sets the header; _headers stays for
// `wrangler`-served previews and any deploy that uploads it.

export const HASHED_ASSET_PREFIX = "/_astro/";
export const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function isHashedAssetPath(pathname: string): boolean {
	return pathname.startsWith(HASHED_ASSET_PREFIX);
}

// Only a found file is immutable: a 404 must stay uncached so a deploy that
// adds the file is seen. 304 repeats the 200's caching headers.
export async function serveHashedAsset(
	request: Request,
	assets: Fetcher
): Promise<Response> {
	const response = await assets.fetch(request);
	if (!response.ok && response.status !== 304) return response;
	const cached = new Response(response.body, response);
	cached.headers.set("cache-control", HASHED_ASSET_CACHE_CONTROL);
	return cached;
}
