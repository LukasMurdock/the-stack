import assert from "node:assert/strict";
import test from "node:test";
import { assessRecovery } from "../../src/worker/turret/recovery";

test("recovery is claimed only when enough traffic should have shown the issue", () => {
	const baseline = { sessions: 100, affected: 10 };
	assert.equal(
		assessRecovery(baseline, { sessions: 20, affected: 0 }).verdict,
		"insufficient_traffic"
	);
	const fixed = assessRecovery(baseline, { sessions: 30, affected: 0 });
	assert.equal(fixed.verdict, "likely_fixed");
	assert.ok(Math.abs((fixed.chanceUnchanged ?? 0) - Math.exp(-3)) < 1e-12);
	assert.equal(
		assessRecovery(baseline, { sessions: 30, affected: 1 }).verdict,
		"recurring"
	);
	// Without replay-session evidence before resolution there is no rate.
	for (const before of [
		{ sessions: 0, affected: 0 },
		{ sessions: 50, affected: 0 },
	])
		assert.equal(
			assessRecovery(before, { sessions: 500, affected: 0 }).verdict,
			"no_baseline"
		);
});
