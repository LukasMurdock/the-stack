import {
	OPERATION_TOTALS_SQL,
	OPERATION_ROUTES_SQL,
} from "../src/worker/observability/summary";

// Read-only rollout/investigation helper. Tokens stay in the environment and
// are never included in query output or exception messages.
const recipes: Record<string, string> = {
	totals: OPERATION_TOTALS_SQL,
	routes: OPERATION_ROUTES_SQL,
	"api-error-rate": `SELECT COUNT(*) AS requests, SUM(double3) AS errors,
		100.0 * SUM(double3) / COUNT(*) AS errorRatePct
		FROM events.analyticsEngine.turret_operations
		WHERE timestamp >= $start AND timestamp < $end AND blob1 = 'v1'
		AND blob2 = $environment AND blob4 = 'api' AND blob7 != 'admin' AND blob7 != 'health'`,
	"ingestion-failures": `SELECT COUNT(*) AS requests, SUM(double3) AS errors
		FROM events.analyticsEngine.turret_operations
		WHERE timestamp >= $start AND timestamp < $end AND blob1 = 'v1'
		AND blob2 = $environment AND blob7 = 'ingest'`,
	"release-errors": `SELECT blob3 AS version, blob6 AS route, COUNT(*) AS requests,
		SUM(double3) AS errors, AVG(double1) AS avgDurationMs
		FROM events.analyticsEngine.turret_operations
		WHERE timestamp >= $start AND timestamp < $end AND blob1 = 'v1'
		AND blob2 = $environment AND blob7 != 'admin' AND blob7 != 'health'
		GROUP BY blob3, blob6 ORDER BY errors DESC LIMIT 20`,
};

async function main() {
	const [command, recipe = "totals"] = process.argv.slice(2);
	if (command === "recipes") {
		console.log(JSON.stringify(recipes, null, 2));
		return;
	}
	if (
		!["datasets", "query"].includes(command) ||
		(command === "query" && !recipes[recipe])
	) {
		throw new Error(
			"Usage: pnpm exec tsx scripts/observability.ts recipes | datasets | query <totals|routes|api-error-rate|ingestion-failures|release-errors>"
		);
	}
	const accountTag = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!accountTag || !/^[a-f0-9]{32}$/i.test(accountTag) || !token)
		throw new Error(
			"Set CLOUDFLARE_ACCOUNT_ID and a read-only CLOUDFLARE_API_TOKEN before querying."
		);
	const base = "https://api.cloudflare.com/client/v4/analytics/sql";
	const url = new URL(
		command === "datasets" ? `${base}/introspection` : base
	);
	if (command === "datasets") {
		url.searchParams.set("account_tag", accountTag);
		url.searchParams.set(
			"dataset_name",
			"events.analyticsEngine.turret_operations"
		);
		url.searchParams.set("include_columns", "true");
	}
	const end = new Date(Math.floor(Date.now() / 60_000) * 60_000);
	const response = await fetch(url, {
		method: command === "datasets" ? "GET" : "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
		},
		signal: AbortSignal.timeout(15_000),
		...(command === "query"
			? {
					body: JSON.stringify({
						query: recipes[recipe],
						scope: { accountTag },
						params: {
							start: new Date(
								end.getTime() - 3_600_000
							).toISOString(),
							end: end.toISOString(),
							environment: process.env.APP_ENV ?? "production",
						},
					}),
				}
			: {}),
	});
	if (!response.ok)
		throw new Error(
			`Cloudflare query failed (HTTP ${response.status}); verify dataset access and schema in the account.`
		);
	const body: unknown = await response.json();
	if (
		body &&
		typeof body === "object" &&
		"success" in body &&
		body.success === false
	)
		throw new Error("Cloudflare returned an unsuccessful query response.");
	console.log(JSON.stringify(body, null, 2));
}

main().catch((error: unknown) => {
	console.error(
		error instanceof Error ? error.message : "Observability command failed"
	);
	process.exitCode = 1;
});
