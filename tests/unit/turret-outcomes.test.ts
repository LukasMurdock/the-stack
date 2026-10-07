import assert from "node:assert/strict";
import test from "node:test";
import { turretOutcomeBodySchema } from "../../src/contracts/turret-outcomes";
import { ApiError } from "../../src/react-app/api";
import { outcomeFailureReason } from "../../src/react-app/features/turret/outcomes";
import {
	outcomesSearchSchema,
	successRate,
} from "../../src/react-app/features/turret/outcomeSearch";

test("failure reasons are codes the ingestion contract accepts, never messages", () => {
	const product = new ApiError({
		message: "Name taken by Alice",
		status: 400,
	});
	product.code = "invalid_input";
	const cases = [
		[product, "invalid_input"],
		[new ApiError({ message: "Unavailable", status: 503 }), "http_503"],
		[new TypeError("Failed to fetch"), "network"],
		[new Error("Something about a user"), "error"],
	] as const;
	for (const [error, reason] of cases) {
		assert.equal(outcomeFailureReason(error), reason);
		assert.ok(
			turretOutcomeBodySchema.safeParse({
				attemptId: crypto.randomUUID(),
				workflow: "project.create",
				event: "failed",
				ts: 1,
				reason,
			}).success
		);
	}
});

test("success rate counts finished attempts and outcome links default to failures", () => {
	assert.equal(successRate({ succeeded: 3, failed: 1, abandoned: 0 }), 0.75);
	assert.equal(successRate({ succeeded: 0, failed: 0, abandoned: 0 }), null);
	assert.deepEqual(outcomesSearchSchema.parse({ workflow: "checkout" }), {
		preset: "7d",
		workflow: "project.create",
		status: "failed",
		offset: 0,
	});
});
