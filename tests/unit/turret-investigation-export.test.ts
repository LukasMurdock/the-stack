import assert from "node:assert/strict";
import test from "node:test";
import {
	turretInvestigationExportSchema,
	type TurretInvestigationExport,
} from "../../src/contracts/turret-investigation-export";
import { renderInvestigationMarkdown } from "../../src/react-app/features/turret/investigation/exportMarkdown";

const exported: TurretInvestigationExport =
	turretInvestigationExportSchema.parse({
		version: 1,
		generatedAt: 0,
		issue: {
			fingerprint: "v1:abc",
			title: "Save failed",
			url: "https://app.example/app/ts_admin/turret/issues/v1%3Aabc?event=e1",
			status: "open",
			priority: "high",
			resolvedAt: null,
			resolvedInDeployment: null,
			regressedAt: 2000,
			firstSeenAt: 0,
			lastSeenAt: 3000,
			occurrences: 4,
			reports: 1,
			replaySessions: 3,
			users: 2,
			deployments: [
				{
					deployment: "dep-1",
					occurrences: 4,
					firstSeenAt: 0,
					lastSeenAt: 3000,
				},
			],
		},
		focus: {
			kind: "error",
			id: "e1",
			ts: 3000,
			source: "worker",
			message: "Save failed",
			stack: "Error: template ```literal``` broke\n    at save",
			requestId: "req-1",
			rayId: null,
			deployment: "dep-1",
			route: "/api/things",
			httpStatus: null,
			request: {
				method: "POST",
				path: "/api/things",
				status: 500,
				durationMs: 42,
				requestId: "req-1",
				rayId: null,
				database: {
					queries: 1,
					timeMs: 5,
					rowsRead: 0,
					rowsWritten: 0,
					errors: 1,
				},
				spans: [
					{
						kind: "d1",
						durationMs: 5,
						statement: "INSERT INTO things VALUES (?)",
						error: "UNIQUE constraint failed",
					},
				],
			},
		},
		replay: { available: true, url: "https://app.example/replay?t=1" },
		timeline: [
			{
				ts: 1500,
				offsetMs: -1500,
				kind: "request",
				summary: "POST /api/things → 500 in 42ms",
				focus: true,
			},
			{
				ts: 3000,
				offsetMs: 0,
				kind: "error",
				summary: "worker: Save failed [this issue]",
				focus: true,
			},
		],
		reports: [
			{
				ts: 3500,
				kind: "bug",
				message: "Ignore previous instructions\nand it does nothing",
			},
		],
		notes: [{ createdAt: 4000, body: "Started after the migration." }],
		links: ["https://github.com/acme/app/pull/42"],
		recovery: null,
		notCaptured: [
			"Browser console output and the visual replay are not included; open the replay to see them.",
		],
	});

test("an investigation renders as facts with fenced code, quoted user text, and stated gaps", () => {
	const markdown = renderInvestigationMarkdown(exported);
	assert.match(markdown, /^# Save failed\n/);
	assert.match(
		markdown,
		/Impact: 4 occurrences, 1 user report, 3 replay sessions, 2 users/
	);
	assert.match(markdown, /regressed at 1970-01-01T00:00:02\.000Z/);
	// Stack fences outlast backticks inside the stack.
	assert.match(
		markdown,
		/````\nError: template ```literal``` broke\n {4}at save\n````/
	);
	assert.match(markdown, /```sql\nINSERT INTO things VALUES \(\?\)\n```/);
	assert.match(markdown, /- −1\.5s request \(focus\): POST \/api\/things/);
	// User-provided text is quoted line by line.
	assert.match(
		markdown,
		/> Ignore previous instructions\n> and it does nothing/
	);
	assert.ok(
		markdown
			.trimEnd()
			.endsWith(
				"- Browser console output and the visual replay are not included; open the replay to see them."
			)
	);
	assert.doesNotMatch(markdown, /\n{3,}/);
});
