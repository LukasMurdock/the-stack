import assert from "node:assert/strict";
import test from "node:test";
import {
	linkParts,
	messageBlocks,
	reportArea,
	reporterInitials,
	reporterName,
	reportPath,
	reportSummary,
	webUrl,
} from "../../src/react-app/features/turret/feedback/report";

const origin = "https://app.example.test";

test("a report's page reads as the part of the app it came from", () => {
	assert.equal(reportArea(`${origin}/app/orders/6011c8bb`), "Orders");
	assert.equal(reportArea(`${origin}/app/organizations`), "Organizations");
	assert.equal(reportArea(`${origin}/app/ts_admin/turret`), "Admin");
	assert.equal(reportArea(`${origin}/app`), "Home");
	assert.equal(reportArea(`${origin}/app/new-area`), "New area");
	assert.equal(
		reportPath(`${origin}/app/tickets?status=open`),
		"/app/tickets?status=open"
	);
});

test("only web addresses from a reporter's browser become links", () => {
	for (const unsafe of [
		"javascript:alert(1)",
		"data:text/html,x",
		"not a url",
		"",
		null,
	])
		assert.equal(webUrl(unsafe), null);
	assert.equal(reportArea("javascript:alert(1)"), null);
	assert.deepEqual(linkParts("see javascript:alert(1) now"), [
		{ text: "see javascript:alert(1) now" },
	]);
	assert.deepEqual(linkParts("Sheet: https://example.test/a?b=1, please"), [
		{ text: "Sheet: " },
		{
			text: "https://example.test/a?b=1",
			href: "https://example.test/a?b=1",
		},
		{ text: ", please" },
	]);
});

test("a report scans by its opening, without repeating it or its markers", () => {
	assert.deepEqual(reportSummary("Queue froze. It stayed at 12."), {
		headline: "Queue froze.",
		preview: "It stayed at 12.",
	});
	assert.deepEqual(reportSummary("Sort newest first"), {
		headline: "Sort newest first",
		preview: "",
	});
	assert.equal(
		reportSummary("Some notes. Alerts:\n- too many\n- only replies")
			.preview,
		"Alerts: too many · only replies"
	);
	// Version numbers aren't the end of a sentence.
	assert.equal(
		reportSummary("Broke on v1.2 today. Sorry").headline,
		"Broke on v1.2 today."
	);
	assert.deepEqual(
		reportSummary("Notes:\n- too many\n- only replies\n\n-Morgan"),
		{
			headline: "Notes:",
			preview: "too many · only replies",
		}
	);
});

test("a long report keeps the structure its author gave it", () => {
	assert.deepEqual(
		messageBlocks(
			"Opening line.\nStill opening.\n\nClients tab:\n-Good overall, keep it\n- Search works\n\nThanks!\n-Morgan"
		),
		[
			{ kind: "paragraph", text: "Opening line.\nStill opening." },
			{ kind: "heading", text: "Clients tab" },
			{ kind: "list", items: ["Good overall, keep it", "Search works"] },
			{ kind: "paragraph", text: "Thanks!\n-Morgan" },
		]
	);
	// A sentence ending in a colon stays a sentence.
	assert.deepEqual(
		messageBlocks("Here is what I saw today. It broke when I did this:"),
		[
			{
				kind: "paragraph",
				text: "Here is what I saw today. It broke when I did this:",
			},
		]
	);
});

test("a reporter reads by the start of their address", () => {
	assert.equal(reporterName("sam.rivera@example.test"), "sam.rivera");
	assert.equal(reporterName("user-123"), "user-123");
	assert.equal(reporterInitials("sam.rivera@example.test"), "SR");
	assert.equal(reporterInitials("ascala@example.test"), "AS");
});
