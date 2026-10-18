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
