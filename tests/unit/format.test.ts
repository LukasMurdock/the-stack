import assert from "node:assert/strict";
import test from "node:test";
import { formatAgo } from "../../src/react-app/ui/format";

test("recent moments read relative; Yesterday is the calendar day", () => {
	const noon = Date.parse("2026-11-08T12:00:00");
	assert.equal(formatAgo(noon - 5 * 60_000, noon), "5 min ago");
	assert.equal(formatAgo(noon - 3 * 3_600_000, noon), "3 h ago");
	assert.equal(
		formatAgo(Date.parse("2026-11-07T01:00:00"), noon),
		"Yesterday"
	);
	assert.equal(formatAgo(Date.parse("2026-11-06T21:30:00"), noon), "Nov 6");
});
