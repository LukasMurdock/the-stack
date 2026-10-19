import assert from "node:assert/strict";
import test from "node:test";

import {
	resolveTurretMode,
	resolveTurretModeStatus,
} from "../../src/worker/turret/mode";

test("resolveTurretMode defaults to full", () => {
	assert.equal(resolveTurretMode(undefined), "full");
	assert.equal(resolveTurretMode(""), "full");
	assert.equal(resolveTurretMode("bogus"), "full");
});

test("mode status disables ingest for off/basic", () => {
	const off = resolveTurretModeStatus({
		modeRaw: "off",
		hasSigningKey: true,
	});
	assert.equal(off.ingestEnabled, false);
	assert.equal(off.effectiveMode, "off");

	const basic = resolveTurretModeStatus({
		modeRaw: "basic",
		hasSigningKey: true,
	});
	assert.equal(basic.ingestEnabled, false);
	assert.equal(basic.effectiveMode, "basic");
});
