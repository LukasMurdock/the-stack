import type { Bindings } from "../../src/worker/index";

type TestBindings = {
	[Key in keyof Bindings]?: Bindings[Key] extends string | undefined
		? string
		: Bindings[Key];
};

export function testBindings(bindings: TestBindings): Bindings {
	// SAFETY: each route fixture supplies the bindings its exercised path uses. Other platform bindings are intentionally absent, and generated string literals are widened for alternate test deployments. This assertion is confined to tests.
	return bindings as Bindings;
}

export function unavailableD1(message: string): D1Database {
	function fail(): never {
		throw new Error(message);
	}
	return {
		prepare: fail,
		batch: fail,
		exec: fail,
		withSession: fail,
		dump: fail,
	};
}

class UntracedSpan implements Span {
	readonly isTraced = false;
	spanContext() {
		return { traceId: "", spanId: "", traceFlags: 0 };
	}
	setAttribute() {
		return this;
	}
	setAttributes() {
		return this;
	}
	recordException() {}
	updateName() {
		return this;
	}
	setStatus() {
		return this;
	}
	end() {}
}

// A complete ExecutionContext for calling a Worker's fetch handler the way
// Cloudflare does; background work is discarded and nothing is traced.
export function untracedExecutionContext(): ExecutionContext {
	return {
		waitUntil() {},
		passThroughOnException() {},
		abort() {},
		props: {},
		tracing: {
			enterSpan: (_name, run, ...args) =>
				run(new UntracedSpan(), ...args),
			startActiveSpan: (_name, run, ...args) =>
				run(new UntracedSpan(), ...args),
			startSpan: () => new UntracedSpan(),
			getActiveSpan: () => undefined,
			Span: UntracedSpan,
		},
	};
}
