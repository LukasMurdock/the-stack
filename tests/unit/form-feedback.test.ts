import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ApiError } from "../../src/react-app/api";
import { MutationFeedback } from "../../src/react-app/forms/feedback";

test("form feedback exposes actionable server field errors", () => {
	const error = new ApiError({
		message: "Check the submitted values.",
		status: 400,
	});
	error.fields = {
		name: "Enter a name.",
		description: "Use 2000 characters or fewer.",
	};
	const markup = renderToStaticMarkup(
		createElement(MutationFeedback, { error })
	);
	assert.match(markup, /role="alert"/);
	assert.match(markup, /name: Enter a name\./);
	assert.match(markup, /description: Use 2000 characters or fewer\./);
});
