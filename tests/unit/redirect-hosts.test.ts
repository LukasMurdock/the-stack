import assert from "node:assert/strict";
import test from "node:test";
import { redirectToAppUrl } from "../../src/worker/http/redirect-hosts";

const env = {
	APP_URL: "https://app.example",
	APP_REDIRECT_HOSTS: "old.example.workers.dev, Older.example",
};

test("a former host redirects to the same path and query on APP_URL", () => {
	const get = redirectToAppUrl(
		new Request("https://old.example.workers.dev/app/orders?tab=open"),
		env
	);
	assert.equal(get?.status, 301);
	assert.equal(
		get?.headers.get("location"),
		"https://app.example/app/orders?tab=open"
	);
	const post = redirectToAppUrl(
		new Request("https://older.example/api/auth/sign-in/email", {
			method: "POST",
		}),
		env
	);
	assert.equal(post?.status, 308);
	assert.equal(
		post?.headers.get("location"),
		"https://app.example/api/auth/sign-in/email"
	);
});

test("APP_URL's host and unlisted hosts, such as version previews, are served", () => {
	for (const url of [
		"https://app.example/app",
		"https://0ea626d1-old.example.workers.dev/api/readiness",
	])
		assert.equal(redirectToAppUrl(new Request(url), env), null);
	assert.equal(
		redirectToAppUrl(new Request("https://old.example.workers.dev/"), {
			APP_URL: env.APP_URL,
			APP_REDIRECT_HOSTS: "",
		}),
		null
	);
});
