import assert from "node:assert/strict";
import test from "node:test";
import { appName } from "../../src/react-app/components/nav-items";
import { documentTitle } from "../../src/react-app/ui/document-title";

test("the tab title names the page, then the app", () => {
	assert.equal(documentTitle("Organizations"), `Organizations · ${appName}`);
	// An h1 spread over lines (a name, then a note) reads as one line.
	assert.equal(
		documentTitle("  Acme\n\t  Archived "),
		`Acme Archived · ${appName}`
	);
});

test("a page without its own heading is titled by the app alone", () => {
	for (const heading of [undefined, null, "", "  ", appName])
		assert.equal(documentTitle(heading), appName);
});
