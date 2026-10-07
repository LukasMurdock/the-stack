import assert from "node:assert/strict";
import test from "node:test";
import {
	isRedirect,
	createRootRoute,
	createRoute,
	createRouter,
	createMemoryHistory,
} from "@tanstack/react-router";

test("session failures propagate and signed-out redirects exclude URL secrets", async (t) => {
	let response = Response.json(
		{ message: "Session unavailable" },
		{ status: 503 }
	);
	// Better Auth captures fetch when its client is created. Mock the HTTP boundary
	// before importing the real client, rather than replacing its dynamic proxy.
	t.mock.method(globalThis, "fetch", async () => response.clone());
	const root = createRootRoute();
	const routeTree = root.addChildren([
		createRoute({ getParentRoute: () => root, path: "/organizations" }),
	]);
	const { requireUser } = await import("../../src/react-app/auth");
	await assert.rejects(
		() =>
			requireUser({
				location: { publicHref: "/workspace/organizations" },
			}),
		/Session unavailable/
	);
	response = Response.json(null);

	for (const basepath of ["/app", "/workspace", "/"]) {
		const mount = basepath === "/" ? "" : basepath;
		const router = createRouter({
			routeTree,
			basepath,
			history: createMemoryHistory({
				initialEntries: [`${mount}/organizations`],
			}),
		});
		const location = router.buildLocation({
			to: "/organizations",
			search: { q: "term" },
			hash: "secret",
		});
		await assert.rejects(
			() => requireUser({ location }),
			(error: unknown) => {
				assert.ok(isRedirect(error));
				assert.equal(error.options.to, "/login");
				assert.deepEqual(error.options.search, {
					redirect: `${mount}/organizations?q=term`,
				});
				return true;
			}
		);
	}
});
