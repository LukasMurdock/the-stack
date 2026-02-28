import assert from "node:assert/strict";
import test from "node:test";

import { cn } from "../../src/lib/utils";

test("cn merges class names", () => {
	assert.equal(cn("px-2", "py-1"), "px-2 py-1");
});

test("cn resolves conflicting tailwind classes", () => {
	assert.equal(cn("px-2", "px-4"), "px-4");
});
