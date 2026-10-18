import { log as simpleLog, createRequestLogger } from "evlog";
import type { RequestLogger } from "evlog";
import { createWorkersLogger, initWorkersLogger } from "evlog/workers";
import type { ObservabilityContext } from "./tracing";
import type { EmailType } from "../email/send-email";

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
	type: EmailType;
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
	type?: EmailType;
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

// Recording the last send outcome (CORE_KV) failed; the send itself already
// succeeded or logged its own failure.
function recordEmailOutcomeStoreFailure(args: {
	outcome: "accepted" | "failed";
	error: unknown;
}): void {
	simpleLog.error({
		action: "email.outcome_record_failed",
		email: { outcome: args.outcome },
		error: {
			message:
				args.error instanceof Error
					? args.error.message
					: String(args.error),
		},
	});
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

// The audit record of an administrator emailing someone a sign-in link. Ids
// only: never the address, the link or its token.
function recordAdminSignInLinkSentEvent(args: {
	actorId: string;
	userId: string;
}): void {
	simpleLog.info({
		action: "admin.sign_in_link_sent",
		admin: { actorId: args.actorId },
		user: { id: args.userId },
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
	recordAdminSignInLinkSentEvent,
	recordFlagFallbacks,
	recordAdminUserCreatedEvent,
	recordEmailLogOnlyEvent,
	recordEmailSendFailure,
	recordEmailOutcomeStoreFailure,
};
export type { FlagFallback, WorkerRequestLogFields };
