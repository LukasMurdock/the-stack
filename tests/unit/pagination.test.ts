import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Pagination } from "../../src/react-app/ui/Pagination";

function label(offset: number, total: number) {
	const markup = renderToStaticMarkup(
		createElement(Pagination, { page: { offset, total }, onPage() {} })
	);
	return /<span[^>]*>([^<]*)<\/span>/.exec(markup)?.[1];
}

// The offset comes from the URL, and pageSchema accepts any integer, so a
// page past the end must still be named by a whole page number.
test("pagination labels a page past the end with a whole page number", () => {
	assert.equal(label(50, 1_095), "51–100 of 1,095");
	assert.equal(label(100, 60), "Page 3");
	assert.equal(label(7, 0), "Page 1");
	assert.equal(label(149, 10), "Page 3");
});
