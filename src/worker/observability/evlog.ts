import { log as simpleLog, createRequestLogger } from "evlog";
import type { RequestLogger } from "evlog";
import { createWorkersLogger, initWorkersLogger } from "evlog/workers";
import type { ObservabilityContext } from "./tracing";

type WorkerRequestLogFields = {
	path: string;
	action: string;
	app: {
		env?: string;
		version?: string;
	};
	cloudflare: {
		rayId?: string | null;
		colo?: string | null;
	};
	turret: {
		sessionId?: string | null;
		replayTs?: number | null;
	};
	route: {
		pathTemplate: string;
	};
	d1: {
		captured: boolean;
		queries: number;
		timeMs: number;
		rowsRead: number;
		rowsWritten: number;
		errors: number;
		droppedSpans: number;
	};
	error: {
		kind?: string | null;
		message?: string | null;
	};
	durationMs: number;
};

initWorkersLogger({
	env: { service: "the-stack-worker" },
	pretty: false,
	stringify: false,
	redact: {
		paths: [
			"headers.authorization",
			"headers.cookie",
			"requestHeaders.authorization",
			"requestHeaders.cookie",
		],
		builtins: ["email", "ipv4", "jwt", "bearer"],
	},
});

function createApiRequestLogger(args: {
	request: Request;
	requestId: string;
	pathTemplate: string;
	executionCtx: ObservabilityContext;
}): RequestLogger<WorkerRequestLogFields> {
	const logger = createWorkersLogger<WorkerRequestLogFields>(args.request, {
		requestId: args.requestId,
		executionCtx: args.executionCtx,
	});
	logger.set({ path: args.pathTemplate });
	return logger;
}

function recordEmailLogOnlyEvent(args: {
	type: "reset-password" | "verify-email" | "generic";
	to?: string;
	from?: string;
	subject?: string;
}): void {
	simpleLog.info({
		action: "email.log_only",
		email: args,
	});
}

function recordEmailSendFailure(args: {
	type?: "reset-password" | "verify-email" | "generic";
	error: unknown;
	provider?: string;
	code?: string;
	requestId?: string;
	environment?: string;
	version?: string;
}): void {
	const logger = createRequestLogger({ requestId: args.requestId });
	logger.set({
		action: "email.send_failed",
		app: { env: args.environment, version: args.version },
		email: { type: args.type, provider: args.provider, code: args.code },
	});
	logger.error(args.error instanceof Error ? args.error : String(args.error));
	logger.emit();
}

// The audit record of an administrator creating an account. Explicit fields
// only: never the starting password, and ids rather than the email address.
function recordAdminUserCreatedEvent(args: {
	actorId: string;
	userId: string;
	role: "user" | "admin";
	emailVerification: "verified" | "unverified";
}): void {
	simpleLog.info({
		action: "admin.user_created",
		admin: { actorId: args.actorId },
		user: {
			id: args.userId,
			role: args.role,
			emailVerification: args.emailVerification,
		},
	});
}

type FlagFallback = {
	readonly key: string;
	readonly cause: string;
	readonly detail?: string;
};

// Flags that served their default because of a misconfiguration (a type
// mismatch, a value outside the schema, a binding error). One event per
// request; the registry bounds how many keys it can name.
function recordFlagFallbacks(fallbacks: readonly FlagFallback[]): void {
	if (fallbacks.length === 0) return;
	simpleLog.warn({ action: "flags.default_served", flags: fallbacks });
}

export {
	createApiRequestLogger,
	recordFlagFallbacks,
	recordAdminUserCreatedEvent,
	recordEmailLogOnlyEvent,
	recordEmailSendFailure,
};
export type { FlagFallback, WorkerRequestLogFields };
