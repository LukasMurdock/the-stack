type UptimeState = {
	version: 1;
	updatedAtMs: number;
	overall: "up" | "degraded" | "down" | "unknown";
	services: Array<{
		id: string;
		name: string;
		status: "up" | "down" | "unknown";
		checkedAtMs: number;
		latencyMs: number | null;
		httpStatus: number | null;
		message: string | null;
	}>;
};

type UptimeEnv = {
	APP_ENV?: string;
	TURRET_UPTIME: KVNamespace;
	APP?: Fetcher;
	APP_URL?: string;
};

const STATUS_KEY = "uptime:status:v1";

function computeOverall(services: UptimeState["services"]): UptimeState["overall"] {
	if (services.length === 0) return "unknown";
	const ups = services.filter((s) => s.status === "up").length;
	const downs = services.filter((s) => s.status === "down").length;
	if (downs === 0 && ups === services.length) return "up";
	if (ups === 0 && downs === services.length) return "down";
	if (downs > 0) return "degraded";
	return "unknown";
}

async function readState(env: UptimeEnv): Promise<UptimeState | null> {
	try {
		const raw = await env.TURRET_UPTIME.get(STATUS_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as UptimeState;
		if (!parsed || parsed.version !== 1) return null;
		return parsed;
	} catch {
		return null;
	}
}

async function writeState(env: UptimeEnv, state: UptimeState): Promise<void> {
	await env.TURRET_UPTIME.put(STATUS_KEY, JSON.stringify(state));
}

async function checkViaFetcher(args: {
	fetcher: Fetcher;
	name: string;
	id: string;
	url: string;
	timeoutMs: number;
}): Promise<UptimeState["services"][number]> {
	const startedAt = Date.now();
	try {
		const res = await args.fetcher.fetch(
			new Request(args.url, {
				method: "GET",
				headers: { "User-Agent": "the-stack-uptime" },
				signal: AbortSignal.timeout(args.timeoutMs),
			})
		);
		const latencyMs = Math.max(0, Date.now() - startedAt);
		return {
			id: args.id,
			name: args.name,
			status: res.ok ? "up" : "down",
			checkedAtMs: Date.now(),
			latencyMs,
			httpStatus: res.status,
			message: res.ok ? null : `HTTP ${res.status}`,
		};
	} catch (err) {
		const latencyMs = Math.max(0, Date.now() - startedAt);
		const msg = err instanceof Error ? err.message : "fetch_failed";
		return {
			id: args.id,
			name: args.name,
			status: "down",
			checkedAtMs: Date.now(),
			latencyMs,
			httpStatus: null,
			message: msg,
		};
	}
}

async function checkViaInternet(args: {
	name: string;
	id: string;
	url: string;
	timeoutMs: number;
}): Promise<UptimeState["services"][number]> {
	const startedAt = Date.now();
	try {
		const res = await fetch(args.url, {
			method: "GET",
			headers: { "User-Agent": "the-stack-uptime" },
			signal: AbortSignal.timeout(args.timeoutMs),
		});
		const latencyMs = Math.max(0, Date.now() - startedAt);
		return {
			id: args.id,
			name: args.name,
			status: res.ok ? "up" : "down",
			checkedAtMs: Date.now(),
			latencyMs,
			httpStatus: res.status,
			message: res.ok ? null : `HTTP ${res.status}`,
		};
	} catch (err) {
		const latencyMs = Math.max(0, Date.now() - startedAt);
		const msg = err instanceof Error ? err.message : "fetch_failed";
		return {
			id: args.id,
			name: args.name,
			status: "down",
			checkedAtMs: Date.now(),
			latencyMs,
			httpStatus: null,
			message: msg,
		};
	}
}

async function runChecks(env: UptimeEnv): Promise<UptimeState> {
	const services: UptimeState["services"] = [];

	// 1) Internal check (service binding) - always works even without a public domain.
	if (env.APP) {
		services.push(
			await checkViaFetcher({
				fetcher: env.APP,
				id: "app_internal_health",
				name: "App (internal)",
				url: "https://app/api/health",
				timeoutMs: 5000,
			})
		);
	} else {
		services.push({
			id: "app_internal_health",
			name: "App (internal)",
			status: "unknown",
			checkedAtMs: Date.now(),
			latencyMs: null,
			httpStatus: null,
			message: "missing_service_binding",
		});
	}

	// 2) External check (public URL) - proves real user-reachable uptime.
	if (env.APP_URL) {
		try {
			const base = new URL(env.APP_URL);
			services.push(
				await checkViaInternet({
					id: "app_public_health",
					name: "App (public)",
					url: new URL("/api/health", base).toString(),
					timeoutMs: 5000,
				})
			);
		} catch {
			services.push({
				id: "app_public_health",
				name: "App (public)",
				status: "unknown",
				checkedAtMs: Date.now(),
				latencyMs: null,
				httpStatus: null,
				message: "invalid_app_url",
			});
		}
	}

	const state: UptimeState = {
		version: 1,
		updatedAtMs: Date.now(),
		overall: computeOverall(services),
		services,
	};

	return state;
}

function renderHtml(state: UptimeState | null): string {
	const updatedAt = state?.updatedAtMs ? new Date(state.updatedAtMs).toISOString() : null;
	const overall = state?.overall ?? "unknown";
	const services = state?.services ?? [];

	function statusColor(s: string): string {
		if (s === "up") return "#0f766e";
		if (s === "degraded") return "#b45309";
		if (s === "down") return "#b91c1c";
		return "#334155";
	}

	const rows = services
		.map((svc) => {
			const when = new Date(svc.checkedAtMs).toISOString();
			const latency = svc.latencyMs == null ? "-" : `${svc.latencyMs}ms`;
			const code = svc.httpStatus == null ? "-" : String(svc.httpStatus);
			const msg = svc.message ?? "";
			return `
        <tr>
          <td class="name">${escapeHtml(svc.name)}</td>
          <td><span class="pill" style="background:${statusColor(svc.status)}">${escapeHtml(svc.status)}</span></td>
          <td>${escapeHtml(latency)}</td>
          <td>${escapeHtml(code)}</td>
          <td class="muted">${escapeHtml(when)}</td>
          <td class="muted">${escapeHtml(msg)}</td>
        </tr>`;
		})
		.join("\n");

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Uptime</title>
    <style>
      :root {
        --bg: #0b1220;
        --card: rgba(255, 255, 255, 0.08);
        --border: rgba(255, 255, 255, 0.12);
        --text: rgba(255, 255, 255, 0.92);
        --muted: rgba(255, 255, 255, 0.6);
      }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        background:
          radial-gradient(1200px 800px at 20% 10%, rgba(15, 118, 110, 0.35), transparent 60%),
          radial-gradient(1000px 700px at 85% 25%, rgba(180, 83, 9, 0.25), transparent 60%),
          var(--bg);
        color: var(--text);
      }
      .wrap { max-width: 980px; margin: 0 auto; padding: 28px 16px 52px; }
      header { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; }
      h1 { margin: 0; font-size: 28px; letter-spacing: -0.02em; }
      .meta { color: var(--muted); font-size: 12px; }
      .card {
        margin-top: 16px;
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 14px;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(10px);
      }
      .topline { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .overall { display: inline-flex; align-items: center; gap: 10px; }
      .dot { width: 10px; height: 10px; border-radius: 999px; background: ${statusColor(overall)}; box-shadow: 0 0 0 4px rgba(255, 255, 255, 0.06); }
      .overall strong { font-size: 14px; text-transform: uppercase; letter-spacing: 0.12em; }
      .link { color: var(--text); text-decoration: none; border-bottom: 1px solid rgba(255,255,255,0.25); }
      table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 13px; }
      th, td { padding: 10px 10px; border-top: 1px solid var(--border); vertical-align: top; }
      th { text-align: left; color: var(--muted); font-weight: 600; }
      .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; color: #fff; }
      .muted { color: var(--muted); }
      .name { font-weight: 600; }
      @media (max-width: 720px) {
        header { flex-direction: column; align-items: flex-start; }
        th:nth-child(5), td:nth-child(5) { display: none; }
        th:nth-child(6), td:nth-child(6) { display: none; }
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <header>
        <h1>Uptime</h1>
        <div class="meta">${updatedAt ? `Updated ${escapeHtml(updatedAt)}` : "No data yet"}</div>
      </header>
      <div class="card">
        <div class="topline">
          <div class="overall"><span class="dot"></span><strong>${escapeHtml(overall)}</strong></div>
          <a class="link" href="/uptime.json">JSON</a>
        </div>
        <table>
          <thead>
            <tr>
              <th>Service</th>
              <th>Status</th>
              <th>Latency</th>
              <th>HTTP</th>
              <th>Checked</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            ${rows || `<tr><td colspan="6" class="muted">No checks recorded yet.</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(input: string): string {
	return input
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

export default {
	async fetch(request: Request, env: UptimeEnv, _ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const p = url.pathname;

		if (request.method !== "GET" && request.method !== "HEAD") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		const state = await readState(env);

		if (p === "/uptime.json") {
			return new Response(JSON.stringify(state ?? { version: 1, overall: "unknown", updatedAtMs: 0, services: [] }), {
				status: 200,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "public, max-age=60",
				},
			});
		}

		if (p === "/internal/uptime.json") {
			return new Response(JSON.stringify(state ?? { version: 1, overall: "unknown", updatedAtMs: 0, services: [] }), {
				status: 200,
				headers: {
					"Content-Type": "application/json; charset=utf-8",
					"Cache-Control": "no-store",
				},
			});
		}

		if (p === "/uptime" || p === "/uptime/" || p === "/") {
			return new Response(renderHtml(state), {
				status: 200,
				headers: {
					"Content-Type": "text/html; charset=utf-8",
					"Cache-Control": "public, max-age=60",
				},
			});
		}

		return new Response("Not Found", { status: 404 });
	},

	async scheduled(_event: ScheduledEvent, env: UptimeEnv, ctx: ExecutionContext): Promise<void> {
		ctx.waitUntil(
			(async () => {
				const state = await runChecks(env);
				await writeState(env, state);
			})()
		);
	},
};
