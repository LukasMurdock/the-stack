import assert from "node:assert/strict";
import test from "node:test";
import {
	isAdminRole,
	normalizeAccountRole,
} from "../../src/features/auth/policy";

test("account roles preserve admin membership, unknown roles, and ordinary-user display", () => {
	for (const [input, expected] of [
		[undefined, "user"],
		[null, "user"],
		[1, "user"],
		[[], "user"],
		["", "user"],
		[" , ", "user"],
		["user", "user"],
		["admin", "admin"],
		[" user, admin , support ", "admin"],
		["support", "other"],
		["user,support", "other"],
		["administrator", "other"],
		["ADMIN", "other"],
	] as const) {
		assert.equal(normalizeAccountRole(input), expected);
		assert.equal(isAdminRole(input), expected === "admin");
	}
});
