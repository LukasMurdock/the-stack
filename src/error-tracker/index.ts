/**
 * Error Tracker SDK for Cloudflare Workers (Server-Side)
 *
 * Uses RPC via Service Binding for zero-overhead error tracking.
 *
 * Setup:
 * 1. Add service binding to wrangler config:
 *    [[services]]
 *    binding = "TURRET"
 *    service = "error-tracker"
 *    entrypoint = "ErrorTracker"
 *
 * 2. Use in your Worker:
 *    import { withErrorTracking } from '@/error-tracker';
 *
 *    export default withErrorTracking({
 *      projectId: '1',
 *      getRelease: (env) => env.CF_VERSION_METADATA?.id,
 *    }, {
 *      async fetch(request, env, ctx) {
 *        // Your code
 *      }
 *    });
 */

// ============================================================================
// Types
// ============================================================================

type ExecutionContext = {
	waitUntil(promise: Promise<unknown>): void;
};

/**
 * The RPC interface exposed by the Error Tracker Worker
 * This should match the ErrorTracker class in the error-tracker worker
 */
export interface ErrorTracker {
	captureException(
		error: Error,
		context: CaptureContext
	): Promise<{ eventId: string; fingerprint: string }>;

	captureMessage(
		message: string,
		level: "error" | "warning" | "info",
		context: CaptureContext
	): Promise<{ eventId: string }>;

	captureEvent(
		projectId: string,
		event: ErrorEvent
	): Promise<{ eventId: string; fingerprint: string; isNewIssue: boolean }>;
}

export interface CaptureContext {
	projectId: string;
	environment?: string;
	release?: string;
	tags?: Record<string, string>;
	user?: { id?: string; ip_address?: string };
	request?: {
		url: string;
		method: string;
		headers?: Record<string, string>;
	};
	extra?: Record<string, unknown>;
	breadcrumbs?: Breadcrumb[];
	cloudflare?: {
		ray_id?: string;
		colo?: string;
	};
}

export interface Breadcrumb {
	type?: string;
	category?: string;
	message?: string;
	data?: Record<string, unknown>;
	level?: string;
	timestamp?: number;
}

export interface ErrorEvent {
	event_id: string;
	timestamp: string;
	platform: string;
	environment?: string;
	release?: string;
	tags: Record<string, string>;
	exception: {
		type: string;
		value: string;
		stacktrace?: StackFrame[];
	};
	request?: {
		url: string;
		method: string;
		headers?: Record<string, string>;
		query_string?: string;
	};
	contexts: {
		runtime: { name: string; version?: string };
		cloudflare?: { ray_id?: string; colo?: string };
	};
	extra?: Record<string, unknown>;
	fingerprint?: string[];
	level: "error" | "warning" | "info";
	user?: { ip_address?: string };
	breadcrumbs?: Breadcrumb[];
}

export interface StackFrame {
	filename?: string;
	function?: string;
	lineno?: number;
	colno?: number;
	in_app?: boolean;
}

export interface WorkerSDKConfig<E> {
	/** Project ID in the error tracker */
	projectId: string;

	/** Environment name (production, staging, etc.) */
	environment?: string;

	/** Get release/version from env */
	getRelease?: (env: E) => string | undefined;

	/** Name of the service binding (default: TURRET) */
	bindingName?: string;

	/** Include request headers */
	sendDefaultPii?: boolean;

	/** Headers to exclude from capture */
	excludeHeaders?: string[];

	/** Additional tags to add to all events */
	tags?: Record<string, string>;

	/** Called before sending - return null to drop event */
	beforeSend?: (
		error: Error,
		context: CaptureContext
	) => CaptureContext | null;

	/** Enable debug logging */
	debug?: boolean;
}

// ============================================================================
// SDK Implementation
// ============================================================================

/**
 * Create context from request and config
 */
function createContext<E>(
	config: WorkerSDKConfig<E>,
	env: E,
	request?: Request
): CaptureContext {
	const context: CaptureContext = {
		projectId: config.projectId,
		environment: config.environment ?? "production",
		release: config.getRelease?.(env),
		tags: { ...config.tags },
	};

	if (request) {
		const url = new URL(request.url);

		context.request = {
			url: `${url.protocol}//${url.host}${url.pathname}`,
			method: request.method,
		};

		if (config.sendDefaultPii) {
			const headers: Record<string, string> = {};
			const excludeHeaders = config.excludeHeaders ?? [
				"authorization",
				"cookie",
				"x-api-key",
			];

			request.headers.forEach((value, key) => {
				if (!excludeHeaders.includes(key.toLowerCase())) {
					headers[key] = value;
				}
			});

			context.request.headers = headers;
			context.user = {
				ip_address:
					request.headers.get("cf-connecting-ip") ?? undefined,
			};
		}

		// Extract Cloudflare-specific context
		const cf = (request as Request & { cf?: { colo?: string } }).cf;
		context.cloudflare = {
			ray_id: request.headers.get("cf-ray") ?? undefined,
			colo: cf?.colo,
		};
	}

	return context;
}

/**
 * Get the error tracker binding from env
 */
function getBinding<E>(env: E, bindingName: string): ErrorTracker | null {
	const binding = (env as Record<string, unknown>)[bindingName];
	if (!binding) {
		console.warn(`[ErrorTracker] Binding "${bindingName}" not found`);
		return null;
	}
	return binding as ErrorTracker;
}

/**
 * Wrap a Worker with automatic error tracking via RPC
 */
export function withErrorTracking<E extends Record<string, unknown>>(
	config: WorkerSDKConfig<E>,
	handler: ExportedHandler<E>
): ExportedHandler<E> {
	const bindingName = config.bindingName ?? "TURRET";

	return {
		async fetch(
			request: Request,
			env: E,
			ctx: ExecutionContext
		): Promise<Response> {
			const tracker = getBinding(env, bindingName);
			const context = createContext(config, env, request);

			try {
				if (!handler.fetch) {
					return new Response("Not Found", { status: 404 });
				}
				return await handler.fetch(request, env, ctx);
			} catch (error) {
				if (error instanceof Error && tracker) {
					const finalContext = config.beforeSend
						? config.beforeSend(error, context)
						: context;

					if (finalContext) {
						// Use waitUntil so we don't block the error response
						ctx.waitUntil(
							tracker
								.captureException(error, finalContext)
								.catch((e) => {
									if (config.debug) {
										console.error(
											"[ErrorTracker] Failed to capture:",
											e
										);
									}
								})
						);
					}
				}
				throw error;
			}
		},

		async scheduled(
			event: ScheduledEvent,
			env: E,
			ctx: ExecutionContext
		): Promise<void> {
			const tracker = getBinding(env, bindingName);
			const context = createContext(config, env);

			try {
				if (handler.scheduled) {
					await handler.scheduled(event, env, ctx);
				}
			} catch (error) {
				if (error instanceof Error && tracker) {
					context.extra = {
						scheduled: {
							cron: event.cron,
							scheduledTime: event.scheduledTime,
						},
					};

					const finalContext = config.beforeSend
						? config.beforeSend(error, context)
						: context;

					if (finalContext) {
						ctx.waitUntil(
							tracker
								.captureException(error, finalContext)
								.catch(() => {})
						);
					}
				}
				throw error;
			}
		},

		async queue(
			batch: MessageBatch<unknown>,
			env: E,
			ctx: ExecutionContext
		): Promise<void> {
			const tracker = getBinding(env, bindingName);
			const context = createContext(config, env);

			try {
				if (handler.queue) {
					await handler.queue(batch, env, ctx);
				}
			} catch (error) {
				if (error instanceof Error && tracker) {
					context.extra = {
						queue: {
							name: batch.queue,
							messageCount: batch.messages.length,
						},
					};

					const finalContext = config.beforeSend
						? config.beforeSend(error, context)
						: context;

					if (finalContext) {
						ctx.waitUntil(
							tracker
								.captureException(error, finalContext)
								.catch(() => {})
						);
					}
				}
				throw error;
			}
		},
	};
}

// ============================================================================
// Manual Capture Utilities
// ============================================================================

/**
 * Manually capture an exception
 */
export async function captureException<E extends Record<string, unknown>>(
	env: E,
	error: Error,
	context: Partial<CaptureContext> & { projectId: string },
	options: { bindingName?: string } = {}
): Promise<string | null> {
	const binding = getBinding(env, options.bindingName ?? "TURRET");
	if (!binding) return null;

	try {
		const result = await binding.captureException(
			error,
			context as CaptureContext
		);
		return result.eventId;
	} catch (e) {
		console.error("[ErrorTracker] Failed to capture exception:", e);
		return null;
	}
}

/**
 * Manually capture a message
 */
export async function captureMessage<E extends Record<string, unknown>>(
	env: E,
	message: string,
	level: "error" | "warning" | "info",
	context: Partial<CaptureContext> & { projectId: string },
	options: { bindingName?: string } = {}
): Promise<string | null> {
	const binding = getBinding(env, options.bindingName ?? "TURRET");
	if (!binding) return null;

	try {
		const result = await binding.captureMessage(
			message,
			level,
			context as CaptureContext
		);
		return result.eventId;
	} catch (e) {
		console.error("[ErrorTracker] Failed to capture message:", e);
		return null;
	}
}

// ============================================================================
// Types for handler wrapping
// ============================================================================

interface ExportedHandler<E = unknown> {
	fetch?: (
		request: Request,
		env: E,
		ctx: ExecutionContext
	) => Promise<Response>;
	scheduled?: (
		event: ScheduledEvent,
		env: E,
		ctx: ExecutionContext
	) => Promise<void>;
	queue?: (
		batch: MessageBatch<unknown>,
		env: E,
		ctx: ExecutionContext
	) => Promise<void>;
}

interface ScheduledEvent {
	cron: string;
	scheduledTime: number;
}

interface MessageBatch<T> {
	queue: string;
	messages: { id: string; body: T; timestamp: Date }[];
}

// ============================================================================
// Hono Middleware
// ============================================================================

/**
 * Hono middleware for error tracking via RPC
 */
export function honoErrorTracker<E>(
	configOrFactory: WorkerSDKConfig<E> | ((env: E) => WorkerSDKConfig<E>)
) {
	const getConfig = (env: E): WorkerSDKConfig<E> =>
		typeof configOrFactory === "function"
			? configOrFactory(env)
			: configOrFactory;

	return async function middleware(
		c: {
			req: { raw: Request };
			env: E;
			executionCtx: ExecutionContext;
			set: (key: string, value: unknown) => void;
		},
		next: () => Promise<void>
	) {
			const config = getConfig(c.env);
		const bindingName = config.bindingName ?? "TURRET";
		const tracker = getBinding(c.env as Record<string, unknown>, bindingName);
		const context = createContext(config, c.env, c.req.raw);

		// Make context available to route handlers
		c.set("errorContext", context);
		c.set("errorTracker", tracker);

		try {
			await next();
		} catch (error) {
			if (error instanceof Error && tracker) {
				const finalContext = config.beforeSend
					? config.beforeSend(error, context)
					: context;

				if (finalContext) {
					c.executionCtx.waitUntil(
						tracker
							.captureException(error, finalContext)
							.catch(() => {})
					);
				}
			}
			throw error;
		}
	};
}

// ============================================================================
// Exports
// ============================================================================

export type ErrorTrackerRPC = ErrorTracker;


