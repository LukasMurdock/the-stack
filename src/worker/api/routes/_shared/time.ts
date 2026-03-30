const DAY_MS = 24 * 60 * 60 * 1000;

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

export { DAY_MS, startOfUtcWeekMs };
