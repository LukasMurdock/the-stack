import assert from "node:assert/strict";
import test from "node:test";
import {
	HASHED_ASSET_CACHE_CONTROL,
	isHashedAssetPath,
	serveHashedAsset,
} from "../../src/worker/http/hashed-assets";

// An ASSETS binding that answers every request with one response.
function assets(response: Response) {
	const requests: Request[] = [];
	return {
		requests,
		fetch: (input: RequestInfo | URL) => {
			requests.push(
				input instanceof Request ? input : new Request(input)
			);
			return Promise.resolve(response.clone());
		},
		connect: () => {
			throw new Error("not used");
		},
	};
}

const request = new Request("https://app.example/_astro/client.Ab12.js");

test("only Astro's fingerprinted output is a hashed asset", () => {
	assert.equal(isHashedAssetPath("/_astro/client.Ab12.js"), true);
	assert.equal(isHashedAssetPath("/_astro/fonts/inter.woff2"), true);
	for (const path of ["/", "/_astro", "/app/_astro/x.js", "/api/health"])
		assert.equal(isHashedAssetPath(path), false, path);
});

test("a found asset is immutable and keeps its body and content type", async () => {
	const binding = assets(
		new Response("console.log(1)", {
			headers: {
				"content-type": "text/javascript",
				etag: '"abc"',
				"cache-control": "public, max-age=0, must-revalidate",
			},
		})
	);
	const response = await serveHashedAsset(request, binding);
	assert.equal(binding.requests[0]?.url, request.url);
	assert.equal(response.status, 200);
	assert.equal(
		response.headers.get("cache-control"),
		HASHED_ASSET_CACHE_CONTROL
	);
	assert.equal(response.headers.get("content-type"), "text/javascript");
	assert.equal(response.headers.get("etag"), '"abc"');
	assert.equal(await response.text(), "console.log(1)");
});

test("a revalidated asset repeats the policy; a missing one is not cached", async () => {
	const notModified = await serveHashedAsset(
		request,
		assets(new Response(null, { status: 304 }))
	);
	assert.equal(notModified.status, 304);
	assert.equal(
		notModified.headers.get("cache-control"),
		HASHED_ASSET_CACHE_CONTROL
	);
	const missing = await serveHashedAsset(
		request,
		assets(new Response("Not found", { status: 404 }))
	);
	assert.equal(missing.status, 404);
	assert.equal(missing.headers.get("cache-control"), null);
});
