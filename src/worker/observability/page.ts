import { getRequestLocation } from "../../lib/cloudflareRequest";
import { createRequestLogger } from "evlog";
import "./evlog";
import { recordOperation, type OperationEnvironment } from "./metrics";
import { resolveRequestId } from "./request";
import { PAGE_ROUTE_LABEL } from "./route-label";
import { traceOperation, type ObservabilityContext } from "./tracing";

// The Worker boundary does not know Astro's resolved route pattern. Use a
// bounded label rather than logging arbitrary page slugs or account identifiers.
export async function observePageRequest(
	request: Request,
	env: OperationEnvironment,
	ctx: ObservabilityContext,
	handle: () => Promise<Response>
): Promise<Response> {
	const requestId = resolveRequestId(request.headers.get("x-request-id"));
	const route = PAGE_ROUTE_LABEL;
	const started = Date.now();
	const colo = getRequestLocation(request).colo;
	const log = createRequestLogger({
		requestId,
		waitUntil: ctx.waitUntil.bind(ctx),
	});
	log.set({
		action: "page.request",
		method: request.method,
		path: route,
		route: { pathTemplate: route },
		app: { env: env.APP_ENV, version: env.CF_VERSION_METADATA?.id },
		cloudflare: { rayId: request.headers.get("cf-ray"), colo },
	});
	let status = 500;
	let exception = false;
	try {
		const response = await traceOperation(
			ctx,
			"page.request",
			{
				"request.id": requestId,
				"http.route": route,
				"app.env": env.APP_ENV,
				"app.version": env.CF_VERSION_METADATA?.id,
			},
			async (span) => {
				const response = await handle();
				span?.setAttributes({
					"http.response.status_code": response.status,
				});
				return response;
			}
		);
		status = response.status;
		// Astro may return an immutable response. Preserve its stream and status.
		const correlated = new Response(response.body, response);
		correlated.headers.set("x-request-id", requestId);
		return correlated;
	} catch (error) {
		exception = true;
		log.error(error instanceof Error ? error : String(error));
		console.error(error);
		throw error;
	} finally {
		const durationMs = Math.max(0, Date.now() - started);
		if (status >= 500)
			log.set({ error: { kind: exception ? "exception" : "http_5xx" } });
		log.set({ durationMs });
		log.emit({ status });
		recordOperation({
			env,
			requestId,
			surface: "page",
			method: request.method,
			route,
			category: "application",
			colo,
			status,
			durationMs,
		});
	}
}
