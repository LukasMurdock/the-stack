import assert from "node:assert/strict";
import test from "node:test";

import { safeRedirectTarget } from "../../src/react-app/routes/_public/login";

test("safeRedirectTarget allows same-origin /app redirects", () => {
	const previousWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window: { location: { origin: string } } }).window = {
		location: { origin: "http://localhost:4321" },
	};

	try {
		assert.equal(
			safeRedirectTarget("/app/ts_admin/turret"),
			"http://localhost:4321/app/ts_admin/turret"
		);
	} finally {
		if (previousWindow === undefined) {
			delete (globalThis as { window?: unknown }).window;
		} else {
			(globalThis as { window: unknown }).window = previousWindow;
		}
	}
});

test("safeRedirectTarget rejects external and non-app paths", () => {
	const previousWindow = (globalThis as { window?: unknown }).window;
	(globalThis as { window: { location: { origin: string } } }).window = {
		location: { origin: "http://localhost:4321" },
	};

	try {
		assert.equal(safeRedirectTarget("https://example.com/app"), null);
		assert.equal(safeRedirectTarget("/docs"), null);
		assert.equal(safeRedirectTarget(undefined), null);
	} finally {
		if (previousWindow === undefined) {
			delete (globalThis as { window?: unknown }).window;
		} else {
			(globalThis as { window: unknown }).window = previousWindow;
		}
	}
});
