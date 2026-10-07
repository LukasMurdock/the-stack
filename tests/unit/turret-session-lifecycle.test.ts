import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createTurretSession } from "../../src/react-app/features/turret/session";
import { observeTurretCapture } from "../../src/react-app/features/turret/lifecycle";
import {
	getTurretContext,
	setTurretContext,
	clearTurretContext,
} from "../../src/react-app/features/turret/context";

test("stopped capture cannot publish a late initialization or clear its replacement", async (t) => {
	const dom = new JSDOM("", { url: "https://app.test/app/organizations" });
	const descriptors = ["window", "document", "sessionStorage"].map(
		(key) =>
			[key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
	);
	for (const [key, value] of [
		["window", dom.window],
		["document", dom.window.document],
		["sessionStorage", dom.window.sessionStorage],
	] as const)
		Object.defineProperty(globalThis, key, { value, configurable: true });
	t.after(() => {
		clearTurretContext("replacement");
		dom.window.close();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	const started = Promise.withResolvers<void>();
	const response = Promise.withResolvers<Response>();
	let signal: AbortSignal | null | undefined;
	t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
		signal = init?.signal;
		started.resolve();
		return response.promise;
	});
	const capture = createTurretSession();
	await started.promise;
	await capture.stop();
	assert.equal(signal?.aborted, true);
	setTurretContext({
		sessionId: "replacement",
		uploadToken: "replacement-token",
		expiresAt: Date.now() + 60000,
	});
	response.resolve(
		Response.json({
			session_id: "old",
			upload_token: "old-token",
			upload_expires_at: Date.now() + 60000,
			policy_version: "1",
			rrweb: {},
		})
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(getTurretContext()?.sessionId, "replacement");
	await capture.stop();
	assert.equal(getTurretContext()?.sessionId, "replacement");
	clearTurretContext("old");
	assert.equal(getTurretContext()?.sessionId, "replacement");
});

test("shared capture lifecycle cancels pending initialization on identity replacement, failure and disposal", async (t) => {
	const dom = new JSDOM("", { url: "https://app.test/" });
	const descriptors = ["window", "document", "sessionStorage"].map(
		(key) =>
			[key, Object.getOwnPropertyDescriptor(globalThis, key)] as const
	);
	for (const [key, value] of [
		["window", dom.window],
		["document", dom.window.document],
		["sessionStorage", dom.window.sessionStorage],
	] as const)
		Object.defineProperty(globalThis, key, { value, configurable: true });
	t.after(() => {
		dom.window.close();
		for (const [key, descriptor] of descriptors) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	});
	type State = {
		data: { user: { id: string } } | null;
		isPending: boolean;
		error: unknown;
	};
	let listener: ((state: State) => void) | undefined;
	const requests: {
		signal: AbortSignal | null | undefined;
		response: ReturnType<typeof Promise.withResolvers<Response>>;
	}[] = [];
	let started = Promise.withResolvers<void>();
	t.mock.method(globalThis, "fetch", (_url: unknown, init?: RequestInit) => {
		const response = Promise.withResolvers<Response>();
		requests.push({ signal: init?.signal, response });
		started.resolve();
		return response.promise;
	});
	const dispose = observeTurretCapture({
		subscribe(callback) {
			listener = callback;
			return () => {
				listener = undefined;
			};
		},
	});
	function identity(id: string | null, error: unknown = null) {
		listener?.({
			data: id ? { user: { id } } : null,
			isPending: false,
			error,
		});
	}
	identity("first");
	await started.promise;
	identity("first");
	assert.equal(requests.length, 1);
	started = Promise.withResolvers<void>();
	identity("second");
	assert.equal(requests[0].signal?.aborted, true);
	await started.promise;
	identity("second", new Error("Session unavailable"));
	assert.equal(requests[1].signal?.aborted, true);
	// Changes while a lazy import is pending must never start a stale recorder.
	identity("third");
	identity(null);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(requests.length, 2);
	started = Promise.withResolvers<void>();
	identity("fourth");
	await started.promise;
	dispose();
	assert.equal(listener, undefined);
	assert.equal(requests[2].signal?.aborted, true);
	for (const { response } of requests)
		response.resolve(
			Response.json({
				session_id: "stale",
				upload_token: "stale",
				upload_expires_at: Date.now() + 60000,
				policy_version: "1",
				rrweb: {},
			})
		);
	await new Promise<void>((resolve) => setImmediate(resolve));
	assert.equal(getTurretContext(), null);
});

test("expired context cannot authorize telemetry even when the deadline timer is suspended", (t) => {
	const now = Date.now();
	setTurretContext({
		sessionId: "deadline",
		uploadToken: "token",
		expiresAt: now + 1000,
	});
	t.after(() => clearTurretContext("deadline"));
	assert.equal(getTurretContext()?.sessionId, "deadline");
	t.mock.method(Date, "now", () => now + 1000);
	assert.equal(getTurretContext(), null);
});
