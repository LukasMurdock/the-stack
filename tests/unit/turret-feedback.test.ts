import assert from "node:assert/strict";
import test from "node:test";
import { submitUserFeedback } from "../../src/react-app/features/turret/feedback";
import {
	setTurretContext,
	clearTurretContext,
} from "../../src/react-app/features/turret/context";

test("feedback rejects invalid drafts before sending a request", async (t) => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		value: { location: { href: "https://app.test/app" } },
	});
	setTurretContext({
		sessionId: "feedback-test",
		uploadToken: "token",
		expiresAt: Date.now() + 60000,
	});
	const fetch = t.mock.method(globalThis, "fetch", async () =>
		Response.json({ ok: true })
	);
	t.after(() => {
		clearTurretContext("feedback-test");
		if (previous) Object.defineProperty(globalThis, "window", previous);
		else Reflect.deleteProperty(globalThis, "window");
	});
	for (const draft of [
		{ message: "   " },
		{ message: "x".repeat(4001) },
		{ message: "valid", contact: "x".repeat(321) },
	]) {
		await assert.rejects(
			submitUserFeedback({ kind: "bug", ...draft }),
			/required|characters/
		);
	}
	assert.equal(fetch.mock.callCount(), 0);
});
