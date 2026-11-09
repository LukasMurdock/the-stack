// Numbers and dates as people read them.

const counts = new Intl.NumberFormat("en-US");
export function formatCount(count: number) {
	return counts.format(count);
}

// "1 member", "1,204 members".
export function plural(count: number, one: string, many = `${one}s`) {
	return `${formatCount(count)} ${count === 1 ? one : many}`;
}

// A moment as a day: "Oct 25", with the year only when it is not this one.
export function formatDate(timestampMs: number, nowMs = Date.now()) {
	const date = new Date(timestampMs);
	return date.toLocaleDateString("en-US", {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === new Date(nowMs).getFullYear()
			? {}
			: { year: "numeric" }),
	});
}

// A recent moment: "5 min ago", "3 h ago", "Yesterday", then its date.
export function formatAgo(timestampMs: number, nowMs = Date.now()) {
	const minutes = Math.round((nowMs - timestampMs) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const yesterday = new Date(nowMs);
	yesterday.setDate(yesterday.getDate() - 1);
	if (new Date(timestampMs).toDateString() === yesterday.toDateString())
		return "Yesterday";
	return formatDate(timestampMs, nowMs);
}

// A moment's date and time: "Oct 25, 4:24 PM".
export function formatDateTime(timestampMs: number, nowMs = Date.now()) {
	const date = new Date(timestampMs);
	return date.toLocaleString("en-US", {
		month: "short",
		day: "numeric",
		...(date.getFullYear() === new Date(nowMs).getFullYear()
			? {}
			: { year: "numeric" }),
		hour: "numeric",
		minute: "2-digit",
	});
}
