import { expect, test } from "@playwright/test";

// The browser runs serve the production build with Void's asset routing
// (`run_worker_first: true`, set in prepare-e2e), so these requests reach the
// Worker exactly as in production, where Astro's _headers is not uploaded.

const IMMUTABLE = "public, max-age=31536000, immutable";

test("hashed assets are immutable and keep their content types; pages are not", async ({
	page,
	request,
}) => {
	const assets: string[] = [];
	page.on("response", (response) => {
		const { pathname } = new URL(response.url());
		if (pathname.startsWith("/_astro/")) assets.push(pathname);
	});
	const home = await page.goto("/");
	expect(home?.status()).toBe(200);
	await page.waitForLoadState("networkidle");
	expect(home?.headers()["cache-control"] ?? "").not.toContain("immutable");

	const script = assets.find((pathname) => pathname.endsWith(".js"));
	const style = assets.find((pathname) => pathname.endsWith(".css"));
	expect(script, `scripts loaded: ${assets.join(", ")}`).toBeDefined();
	expect(style, `styles loaded: ${assets.join(", ")}`).toBeDefined();
	for (const [pathname, contentType] of [
		[script, /^(text|application)\/javascript/],
		[style, /^text\/css/],
	] as const) {
		const response = await request.get(pathname ?? "");
		expect(response.status(), pathname).toBe(200);
		expect(response.headers()["cache-control"], pathname).toBe(IMMUTABLE);
		expect(response.headers()["content-type"], pathname).toMatch(
			contentType
		);
		expect((await response.body()).byteLength, pathname).toBeGreaterThan(0);
	}

	// A file that does not exist must not be cached for a year.
	const missing = await request.get("/_astro/missing-0000.js");
	expect(missing.status()).toBe(404);
	expect(missing.headers()["cache-control"] ?? "").not.toContain("immutable");
	// Other files from the asset directory keep their own policy.
	const icon = await request.get("/favicon.svg");
	expect(icon.status()).toBe(200);
	expect(icon.headers()["content-type"]).toMatch(/^image\/svg\+xml/);
	expect(icon.headers()["cache-control"] ?? "").not.toContain("immutable");

	// Every icon the page links to is served.
	const icons = await page
		.locator('link[rel="icon"], link[rel="apple-touch-icon"]')
		.evaluateAll((links) =>
			links.map((link) => link.getAttribute("href") ?? "")
		);
	expect(icons).toHaveLength(3);
	for (const pathname of icons) {
		const response = await request.get(pathname);
		expect(response.status(), pathname).toBe(200);
		expect(response.headers()["content-type"], pathname).toMatch(
			/^image\//
		);
	}
});
