function formatTime(ms: number): string {
	return new Date(ms).toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
	});
}

function formatSummaryWindow(summary: { from: number; to: number }): string {
	return `${formatTime(summary.from)}–${formatTime(summary.to)}`;
}

// Operations values are sampled estimates and may be fractional.
function formatCount(n: number): string {
	return Math.round(n).toLocaleString();
}

function formatRate(part: number, total: number): string {
	if (!(total > 0)) return "-";
	const pct = (part / total) * 100;
	if (pct > 0 && pct < 0.1) return "<0.1%";
	return `${pct.toFixed(1)}%`;
}

function formatDuration(ms: number | null): string {
	if (ms == null || !Number.isFinite(ms)) return "-";
	if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
	return `${Math.round(ms)} ms`;
}

function abbreviateVersion(version: string): string {
	if (!version) return "unknown";
	return version.length > 8 ? version.slice(0, 8) : version;
}

export {
	abbreviateVersion,
	formatCount,
	formatDuration,
	formatRate,
	formatSummaryWindow,
	formatTime,
};
