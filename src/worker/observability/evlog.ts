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

export {
	createApiRequestLogger,
	recordEmailLogOnlyEvent,
	recordEmailSendFailure,
};
export type { WorkerRequestLogFields };
