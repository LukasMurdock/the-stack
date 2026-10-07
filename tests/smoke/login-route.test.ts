import assert from "node:assert/strict";
import test from "node:test";
import { safeRedirectTarget } from "../../src/react-app/auth";

const origin = "http://localhost:4321";
test("login returns stay within the configured mount and preserve query and fragment", () => {
	for (const mount of ["/app", "/workspace", "/nested/app/"]) {
		const path = `${mount.replace(/\/$/, "")}/organizations?q=term#section`;
		assert.equal(safeRedirectTarget(path, mount, origin), path);
		assert.equal(
			safeRedirectTarget(`${origin}${path}`, mount, origin),
			path
		);
		assert.equal(
			safeRedirectTarget(mount.replace(/\/$/, ""), mount, origin),
			mount.replace(/\/$/, "")
		);
		for (const href of [
			"https://example.com/app",
			"//example.com/app",
			"/docs",
			`${mount.replace(/\/$/, "")}lication`,
			`${mount.replace(/\/$/, "")}/../outside`,
			undefined,
		]) {
			assert.equal(safeRedirectTarget(href, mount, origin), null);
		}
	}
	assert.equal(
		safeRedirectTarget(`${origin}//example.com/path`, "/", origin),
		null
	);
	assert.equal(
		safeRedirectTarget("/organizations", "/", origin),
		"/organizations"
	);
	assert.equal(
		safeRedirectTarget("https://example.com/organizations", "/", origin),
		null
	);
});
