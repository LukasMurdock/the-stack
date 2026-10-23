import { DAY_MS } from "../../../../lib/time";

function startOfUtcWeekMs(ms: number): number {
	// Monday 00:00:00 UTC
	const d = new Date(ms);
	const day = d.getUTCDay();
	const daysSinceMonday = (day + 6) % 7;
	const startOfDay = Date.UTC(
		d.getUTCFullYear(),
		d.getUTCMonth(),
		d.getUTCDate()
	);
	return startOfDay - daysSinceMonday * DAY_MS;
}

export { startOfUtcWeekMs };
