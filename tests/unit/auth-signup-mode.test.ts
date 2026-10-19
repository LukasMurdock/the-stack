import test from "node:test";
import assert from "node:assert/strict";

import { resolveAuthSignupMode } from "../../src/worker/auth-signup-mode";

test("resolveAuthSignupMode defaults to invite_only", () => {
	assert.equal(resolveAuthSignupMode(undefined), "invite_only");
	assert.equal(resolveAuthSignupMode(""), "invite_only");
	assert.equal(resolveAuthSignupMode("garbage"), "invite_only");
});

test("resolveAuthSignupMode accepts open case-insensitively", () => {
	assert.equal(resolveAuthSignupMode("open"), "open");
	assert.equal(resolveAuthSignupMode(" OPEN "), "open");
});
