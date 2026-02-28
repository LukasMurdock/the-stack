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

test("resolveTurretMode parses known values", () => {
	assert.equal(resolveTurretMode("off"), "off");
	assert.equal(resolveTurretMode("basic"), "basic");
	assert.equal(resolveTurretMode("full"), "full");
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

test("mode status degrades full to basic when key missing", () => {
	const status = resolveTurretModeStatus({
		modeRaw: "full",
		hasSigningKey: false,
	});
	assert.equal(status.configuredMode, "full");
	assert.equal(status.effectiveMode, "basic");
	assert.equal(status.ingestEnabled, false);
	assert.equal(status.reason, "missing_turret_signing_key");
});
