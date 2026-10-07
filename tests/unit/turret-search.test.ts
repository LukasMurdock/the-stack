import { turretHasErrorSchema } from "../../src/contracts/turret";
import assert from "node:assert/strict";
import test from "node:test";
import {
	formatOccurrenceChange,
	issuesSearchSchema,
	issueDetailSearchSchema,
} from "../../src/react-app/features/turret/issueSearch";
import {
	replaySearchSchema,
	replaySessionSearchSchema,
} from "../../src/react-app/features/turret/session/replaySearch";
import {
	turretTrendQuerySchema,
	resolveTurretTimeRange,
	turretRangeDurations,
	TURRET_TREND_POINTS_MAX,
} from "../../src/contracts/turret-time-range";

test("replay filter values agree across HTTP validation and forgiving navigation", () => {
	const httpField = turretHasErrorSchema.optional();
	for (const [value, expected] of [
		[true, true],
		[false, false],
		["1", true],
		["0", false],
		["true", true],
		["false", false],
	] as const) {
		assert.equal(httpField.parse(value), expected);
		assert.equal(
			replaySearchSchema.parse({ hasError: value }).hasError,
			expected
		);
	}
	assert.equal(httpField.parse(undefined), undefined);
	assert.equal(replaySearchSchema.parse({}).hasError, false);
	for (const value of ["yes", "", 1, null]) {
		assert.equal(httpField.safeParse(value).success, false);
		assert.equal(
			replaySearchSchema.parse({ hasError: value }).hasError,
			false
		);
	}
});

test("date filters preserve timestamps from both typed navigation and serialized URLs", () => {
	const validators = [
		issuesSearchSchema,
		issueDetailSearchSchema,
		replaySearchSchema,
	];
	for (const schema of validators) {
		for (const values of [
			{ from: 1000, to: 2000 },
			{ from: "1000", to: "2000" },
		]) {
			const parsed = schema.parse({ preset: "custom", ...values });
			assert.equal(parsed.from, 1000);
			assert.equal(parsed.to, 2000);
		}
	}
});

test("trend bounds count partial edge buckets and resolve omitted windows from their requested end", () => {
	const step = turretRangeDurations["1h"];
	assert.ok(
		turretTrendQuerySchema.safeParse({
			from: 0,
			to: TURRET_TREND_POINTS_MAX * step,
			bucket: "hour",
		}).success
	);
	assert.equal(
		turretTrendQuerySchema.safeParse({
			from: 1,
			to: TURRET_TREND_POINTS_MAX * step + 1,
			bucket: "hour",
		}).success,
		false
	);
	const range = resolveTurretTimeRange({ to: 10 * step }, 20 * step, step);
	assert.deepEqual(range, { from: 9 * step, to: 10 * step });
});

test("destination defaults preserve distinct windows, explicit filters, and old grouped links", () => {
	assert.equal(replaySearchSchema.parse({}).preset, "1h");
	assert.equal(issuesSearchSchema.parse({}).preset, "24h");
	assert.equal(issueDetailSearchSchema.parse({}).preset, "7d");
	assert.equal(
		issueDetailSearchSchema.parse({ preset: "24h" }).bucket,
		"hour"
	);
	assert.equal(
		issueDetailSearchSchema.parse({ preset: "24h", bucket: "day" }).bucket,
		"day"
	);
	assert.equal(replaySearchSchema.parse({ grouped: "1" }).groupBy, "user");
	assert.equal(
		replaySearchSchema.parse({ grouped: "1", groupBy: "invalid" }).groupBy,
		"user"
	);
	assert.equal(
		replaySearchSchema.parse({ grouped: "1", groupBy: "none" }).groupBy,
		"none"
	);
	assert.equal(replaySearchSchema.parse({ hasError: "true" }).hasError, true);
	assert.equal(
		replaySearchSchema.parse({
			preset: "obsolete",
			limit: "bad",
			offset: "10",
		}).offset,
		10
	);
	assert.equal(
		issuesSearchSchema.parse({ status: "unknown", preset: "unknown" })
			.status,
		"open"
	);
});

test("investigation links restore the occurrence and replay moment and drop malformed positions", () => {
	assert.deepEqual(
		(({ event, t }) => ({ event, t }))(
			issueDetailSearchSchema.parse({
				event: "error-1",
				t: "1700000000123",
			})
		),
		{ event: "error-1", t: 1_700_000_000_123 }
	);
	assert.equal(replaySessionSearchSchema.parse({ t: "1500" }).t, 1500);
	for (const t of ["soon", "-1", "1.5"]) {
		assert.equal(issueDetailSearchSchema.parse({ t }).t, undefined);
		assert.equal(replaySessionSearchSchema.parse({ t }).t, undefined);
	}
	assert.equal(issueDetailSearchSchema.parse({ event: "" }).event, undefined);
	assert.equal(
		issueDetailSearchSchema.parse({ report: "feedback-1" }).report,
		"feedback-1"
	);
	assert.equal(
		issuesSearchSchema.parse({ status: "regressed" }).status,
		"regressed"
	);
});

test("inbox links keep impact views and sorts, and describe change against the previous window", () => {
	assert.deepEqual(
		(({ status, sort }) => ({ status, sort }))(
			issuesSearchSchema.parse({ status: "escalating", sort: "users" })
		),
		{ status: "escalating", sort: "users" }
	);
	assert.equal(
		issuesSearchSchema.parse({ sort: "loudest" }).sort,
		"lastSeen"
	);
	assert.equal(issuesSearchSchema.parse({ assignee: "me" }).assignee, "me");
	assert.equal(
		issuesSearchSchema.parse({ assignee: "someone" }).assignee,
		undefined
	);
	assert.equal(formatOccurrenceChange(10, 1), "+900%");
	assert.equal(formatOccurrenceChange(5, 10), "−50%");
	assert.equal(formatOccurrenceChange(10, 10), "no change");
	assert.equal(formatOccurrenceChange(3, 0), "none before");
});
