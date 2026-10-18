import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { formatDate, plural } from "../../src/react-app/ui/format";
import {
	visibleItems,
	type OverflowItem,
} from "../../src/react-app/ui/overflowItems";
import { Unit } from "../../src/react-app/ui/Unit";
import { queryState, rowsState } from "../../src/react-app/ui/unitState";

const query = (isPending: boolean, isError: boolean) => ({
	isPending,
	isError,
	refetch() {},
});

test("a Unit's state follows its query: loading, then error, then empty or ready", () => {
	assert.equal(queryState(query(true, false), 0, "None").kind, "loading");
	assert.equal(queryState(query(false, true), 3, "None").kind, "error");
	assert.deepEqual(queryState(query(false, false), 0, "None"), {
		kind: "empty",
		title: "None",
	});
	assert.equal(queryState(query(false, false), 2, "None").kind, "ready");
	assert.equal(rowsState(0, "None").kind, "empty");
	assert.equal(rowsState(1, "None").kind, "ready");
});

test("a Unit shows its rows only when ready, and owns the other states' copy", () => {
	const render = (state: Parameters<typeof Unit>[0]["state"]) =>
		renderToStaticMarkup(
			createElement(Unit, { title: "Members", state }, "ROWS")
		);
	assert.match(render({ kind: "ready" }), /ROWS/);
	const empty = render({ kind: "empty", title: "No members yet" });
	assert.doesNotMatch(empty, /ROWS/);
	assert.match(empty, /No members yet/);
	const failed = render({ kind: "error", retry() {} });
	assert.match(failed, /role="alert"/);
	assert.match(failed, /Couldn(&#x27;|')t load members/);
	assert.match(failed, /Try again/);
	assert.match(render({ kind: "loading" }), /aria-busy="true"/);
});

test("overflow menus drop leading, trailing and doubled separators", () => {
	const action = (label: string): OverflowItem => ({
		label,
		onSelect() {},
	});
	const labels = (items: OverflowItem[]) =>
		visibleItems(items).map((item) =>
			item === "separator" ? "|" : item.label
		);
	assert.deepEqual(
		labels([
			"separator",
			action("A"),
			"separator",
			"separator",
			action("B"),
		]),
		["A", "|", "B"]
	);
	// A member whose only action is removal: no stray divider above it.
	assert.deepEqual(labels(["separator", action("Remove")]), ["Remove"]);
	assert.deepEqual(labels([action("A"), "separator"]), ["A"]);
	assert.deepEqual(labels(["separator"]), []);
});

test("counts and dates read as people say them", () => {
	assert.equal(plural(1, "member"), "1 member");
	assert.equal(plural(1_204, "member"), "1,204 members");
	assert.equal(plural(0, "project"), "0 projects");
	const now = new Date(2026, 9, 18).getTime();
	assert.equal(formatDate(new Date(2026, 9, 25).getTime(), now), "Oct 25");
	assert.equal(
		formatDate(new Date(2027, 0, 2).getTime(), now),
		"Jan 2, 2027"
	);
});
