import assert from "node:assert/strict";
import test from "node:test";

import { safeRedirectTarget } from "../../src/react-app/routes/_public/login";

test("safeRedirectTarget allows same-origin /app redirects", () => {
	const previousWindow = Object.getOwnPropertyDescriptor(
		globalThis,
		"window"
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { origin: "http://localhost:4321" } },
	});

	try {
		assert.equal(
			safeRedirectTarget("/app/ts_admin/turret"),
			"http://localhost:4321/app/ts_admin/turret"
		);
	} finally {
		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalThis, "window");
		} else {
			Object.defineProperty(globalThis, "window", previousWindow);
		}
	}
});

test("safeRedirectTarget rejects external and non-app paths", () => {
	const previousWindow = Object.getOwnPropertyDescriptor(
		globalThis,
		"window"
	);
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { origin: "http://localhost:4321" } },
	});

	try {
		assert.equal(safeRedirectTarget("https://example.com/app"), null);
		assert.equal(safeRedirectTarget("/docs"), null);
		assert.equal(safeRedirectTarget(undefined), null);
	} finally {
		if (previousWindow === undefined) {
			Reflect.deleteProperty(globalThis, "window");
		} else {
			Object.defineProperty(globalThis, "window", previousWindow);
		}
	}
});
