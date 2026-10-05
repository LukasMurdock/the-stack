// Structural types let Node tests and local contexts run without importing a
// Workers-only module. Production uses ExecutionContext.tracing directly.
export type TraceAttributes = Record<
	string,
	string | number | boolean | undefined
>;

export type TraceSpan = {
	setAttributes(attributes: TraceAttributes): void;
	recordException(error: Error | string): void;
};

export type ObservabilityContext = {
	waitUntil(promise: Promise<unknown>): void;
	tracing?: {
		enterSpan<T>(name: string, callback: (span: TraceSpan) => T): T;
	};
};

export function traceOperation<T>(
	ctx: ObservabilityContext | undefined,
	name: string,
	attributes: TraceAttributes,
	operation: (span?: TraceSpan) => Promise<T>
): Promise<T> {
	const run = async (span?: TraceSpan): Promise<T> => {
		span?.setAttributes(attributes);
		try {
			return await operation(span);
		} catch (error) {
			span?.recordException(
				error instanceof Error ? error : String(error)
			);
			throw error;
		}
	};
	return ctx?.tracing ? ctx.tracing.enterSpan(name, run) : run();
}
