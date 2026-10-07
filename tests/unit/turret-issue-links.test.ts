import assert from "node:assert/strict";
import test from "node:test";
import { describeIssueLink } from "../../src/react-app/features/turret/issueLinks";

test("tracking links read the way people refer to tickets and pull requests", () => {
	assert.deepEqual(
		describeIssueLink("https://github.com/acme/app/pull/42/files"),
		{ label: "acme/app#42", kind: "pull request" }
	);
	assert.deepEqual(
		describeIssueLink("https://github.com/acme/app/issues/7"),
		{
			label: "acme/app#7",
			kind: "issue",
		}
	);
	assert.deepEqual(
		describeIssueLink("https://linear.app/acme/issue/ENG-12?x=1"),
		{ label: "linear.app/acme/issue/ENG-12", kind: "link" }
	);
	assert.deepEqual(describeIssueLink("https://example.com/"), {
		label: "example.com",
		kind: "link",
	});
});
