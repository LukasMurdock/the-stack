import {
	turretSummarySchema,
	type TurretSummary,
} from "../../contracts/observability";

export type AnalyticsSqlBinding = {
	query(input: {
		query: string;
		params: Record<string, string | number>;
	}): Promise<{ data: Record<string, unknown>[] }>;
};
type SummaryEnvironment = {
	APP_ENV?: string;
	TURRET_DB?: D1Database;
	ANALYTICS_SQL?: AnalyticsSqlBinding;
};
type Operations = TurretSummary["operations"];

const aggregates = `COUNT(*) AS requests, SUM(double3) AS serverErrors,
	SUM(double4) AS slowRequests, AVG(double1) AS avgDurationMs,
	quantileWeighted(0.95, double1, sampleInterval) AS p95DurationMs`;
const filter = `FROM events.analyticsEngine.turret_operations
	WHERE timestamp >= $start AND timestamp < $end AND blob1 = 'v1'
	AND blob2 = $environment AND blob7 != 'admin' AND blob7 != 'health'`;
export const OPERATION_TOTALS_SQL = `SELECT ${aggregates} ${filter}`;
export const OPERATION_ROUTES_SQL = `SELECT blob4 AS surface, blob5 AS method,
	blob6 AS route, blob7 AS category, blob3 AS version, ${aggregates} ${filter}
	GROUP BY blob4, blob5, blob6, blob7, blob3 ORDER BY requests DESC LIMIT 10`;

// Cache a single window per binding/environment and coalesce simultaneous loads.
// No global credential, account identifier, or arbitrary client SQL is accepted.
const cache = new WeakMap<
	AnalyticsSqlBinding,
	Map<
		string,
		{
			to: number;
			expiresAt: number;
			result: Promise<Operations>;
		}
	>
>();

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("Analytics SQL timeout")),
					5000
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function operationTotals(row: Record<string, unknown>) {
	const count = (key: string) => {
		if (!(key in row)) throw new Error(`Missing aggregate: ${key}`);
		return Number(row[key] ?? 0);
	};
	const duration = (key: string) =>
		count("requests") === 0 || row?.[key] == null ? null : Number(row[key]);
	return {
		requests: count("requests"),
		serverErrors: count("serverErrors"),
		slowRequests: count("slowRequests"),
		avgDurationMs: duration("avgDurationMs"),
		p95DurationMs: duration("p95DurationMs"),
	};
}

async function queryOperations(
	binding: AnalyticsSqlBinding,
	environment: string,
	from: number,
	to: number
): Promise<Operations> {
	try {
		const params = {
			start: new Date(from).toISOString(),
			end: new Date(to).toISOString(),
			environment,
		};
		const [totals, routes] = await withTimeout(
			Promise.all([
				binding.query({ query: OPERATION_TOTALS_SQL, params }),
				binding.query({ query: OPERATION_ROUTES_SQL, params }),
			])
		);
		if (totals.data.length !== 1)
			throw new Error("Operational aggregate returned no unique row");
		return turretSummarySchema.shape.operations.parse({
			state: "ready",
			totals: operationTotals(totals.data[0]),
			routes: routes.data.map((row) => ({
				...operationTotals(row),
				surface: row.surface,
				method: row.method,
				route: row.route,
				category: row.category,
				version: row.version,
			})),
		});
	} catch (error) {
		console.error(
			{ action: "observability.query_failed", app: { env: environment } },
			error
		);
		return { state: "unavailable", reason: "query_failed" };
	}
}

function loadOperations(
	env: SummaryEnvironment,
	from: number,
	to: number,
	now: number
): Promise<Operations> {
	if (["local", "dev", "development", "test"].includes(env.APP_ENV ?? ""))
		return Promise.resolve({
			state: "unavailable",
			reason: "local_environment",
		});
	const binding = env.ANALYTICS_SQL;
	if (!binding)
		return Promise.resolve({
			state: "unavailable",
			reason: "not_configured",
		});
	const environment = env.APP_ENV ?? "unknown";
	let environments = cache.get(binding);
	if (!environments) {
		environments = new Map();
		cache.set(binding, environments);
	}
	const existing = environments.get(environment);
	if (existing && existing.to === to && existing.expiresAt > now)
		return existing.result;
	const result = queryOperations(binding, environment, from, to);
	environments.set(environment, { to, expiresAt: now + 30_000, result });
	return result;
}

async function loadReplay(
	db: D1Database | undefined,
	from: number,
	to: number
): Promise<TurretSummary["replay"]> {
	if (!db) return { state: "unavailable" };
	try {
		const row = await db
			.prepare(`SELECT COUNT(*) AS replaySessions,
			COALESCE(SUM(CASE WHEN has_error = 1 THEN 1 ELSE 0 END), 0) AS errorReplaySessions,
			COALESCE(SUM(CASE WHEN capture_blocked = 1 THEN 1 ELSE 0 END), 0) AS captureBlocked
			FROM turret_sessions WHERE started_at >= ? AND started_at < ?`)
			.bind(from, to)
			.first<Record<string, number>>();
		if (!row) throw new Error("Replay aggregate returned no row");
		return turretSummarySchema.shape.replay.parse({
			state: "ready",
			totals: row,
		});
	} catch (error) {
		console.error({ action: "turret.summary_failed" }, error);
		return { state: "unavailable" };
	}
}

export async function loadTurretSummary(
	env: SummaryEnvironment,
	now = Date.now()
): Promise<TurretSummary> {
	const to = Math.floor(now / 60_000) * 60_000;
	const from = to - 60 * 60_000;
	const [replay, operations] = await Promise.all([
		loadReplay(env.TURRET_DB, from, to),
		loadOperations(env, from, to, now),
	]);
	return { from, to, replay, operations };
}
