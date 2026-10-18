import assert from "node:assert/strict";
import test from "node:test";
import {
	navItemsFor,
	phoneBarFor,
	type NavItem,
} from "../../src/react-app/components/nav-items";

// The template's own roles stay within one tab row, so browser tests never
// render the phone bar; this pins where a fork's extra areas switch to it.
test("phones keep a tab row up to three areas, then a bar of four plus More", () => {
	const [first] = navItemsFor(true);
	assert.ok(first);
	const area = (index: number): NavItem => ({
		...first,
		label: `Area ${index}`,
	});
	const areas = (count: number) =>
		Array.from({ length: count }, (_, index) => area(index));

	assert.equal(phoneBarFor(areas(3)), null);
	const four = phoneBarFor(areas(4));
	assert.deepEqual([four?.bar.length, four?.more.length], [4, 0]);
	const six = phoneBarFor(areas(6));
	assert.deepEqual(
		six?.more.map((item) => item.label),
		["Area 4", "Area 5"]
	);
});

test("signed-out visitors are offered only the areas meant for everyone", () => {
	const signedOut = navItemsFor(false).map((item) => item.to);
	const signedIn = navItemsFor(true).map((item) => item.to);
	assert.ok(signedOut.length > 0);
	assert.ok(!signedOut.includes("/organizations"));
	assert.ok(signedIn.includes("/organizations"));
	for (const path of signedOut) assert.ok(signedIn.includes(path));
});
