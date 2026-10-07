import type { TurretInvestigationExport } from "../../../../contracts/turret-investigation-export";
import { formatOffset } from "./timeline";

function count(n: number, singular: string, plural = `${singular}s`) {
	return `${n} ${n === 1 ? singular : plural}`;
}

function iso(ms: number) {
	return new Date(ms).toISOString();
}

// Fences text that may itself contain backticks.
function fence(text: string, language = "") {
	const longest = Math.max(
		2,
		...Array.from(text.matchAll(/`+/g), (match) => match[0].length)
	);
	const marker = "`".repeat(longest + 1);
	return `${marker}${language}\n${text}\n${marker}`;
}

// User-provided text is quoted so it reads as evidence, not instructions.
function quote(text: string) {
	return text
		.split("\n")
		.map((line) => `> ${line}`)
		.join("\n");
}

const recoveryVerdicts: Record<string, string> = {
	likely_fixed: "likely fixed",
	insufficient_traffic: "not confirmed yet (too little traffic)",
	recurring: "still occurring",
	no_baseline: "can't be measured (no replay-session baseline)",
};

// Renders an export for a ticket or a coding agent: observed facts with links
// to the evidence, followed by what the export does not contain.
export function renderInvestigationMarkdown(
	exported: TurretInvestigationExport
): string {
	const { issue, focus } = exported;
	const lines: string[] = [
		`# ${issue.title ?? issue.fingerprint}`,
		"",
		"Observed facts from Turret. They describe what happened, not why; treat any cause as a hypothesis to verify.",
		"",
		"## Issue",
		"",
		`- Fingerprint: \`${issue.fingerprint}\``,
		`- Status: ${issue.status}${issue.regressedAt !== null ? ` (regressed at ${iso(issue.regressedAt)})` : ""}, priority ${issue.priority}`,
		...(issue.resolvedAt !== null
			? [
					`- Resolved at ${iso(issue.resolvedAt)}${issue.resolvedInDeployment ? `, expecting the fix after deployment \`${issue.resolvedInDeployment}\`` : ""}`,
				]
			: []),
		`- Seen ${iso(issue.firstSeenAt)} to ${iso(issue.lastSeenAt)}`,
		`- Impact: ${count(issue.occurrences, "occurrence")}, ${count(issue.reports, "user report")}, ${count(issue.replaySessions, "replay session")}, ${count(issue.users, "user")}`,
		`- Investigate: ${issue.url}`,
	];
	if (issue.deployments.length > 0) {
		lines.push("", "### Occurrences by deployment", "");
		for (const d of issue.deployments)
			lines.push(
				`- \`${d.deployment ?? "unknown"}\`: ${d.occurrences} (${iso(d.firstSeenAt)} to ${iso(d.lastSeenAt)})`
			);
	}

	lines.push("", "## Focused evidence", "");
	if (focus === null) {
		lines.push("No retained occurrence or report.");
	} else if (focus.kind === "error") {
		lines.push(
			`Error from \`${focus.source}\` at ${iso(focus.ts)}: ${focus.message ?? "(no message)"}`,
			""
		);
		const correlation = [
			["Request ID", focus.requestId],
			["Ray ID", focus.rayId],
			["Deployment", focus.deployment],
			["Route", focus.route],
			["HTTP status", focus.httpStatus],
		].filter(([, value]) => value !== null);
		for (const [label, value] of correlation)
			lines.push(`- ${label}: \`${value}\``);
		if (focus.stack) lines.push("", fence(focus.stack));
		if (focus.request) {
			const r = focus.request;
			lines.push(
				"",
				"### Failing request",
				"",
				`${r.method} ${r.path} returned ${r.status} in ${r.durationMs}ms. D1: ${count(r.database.queries, "query", "queries")}, ${r.database.timeMs}ms, ${count(r.database.rowsRead, "row")} read, ${r.database.rowsWritten} written, ${count(r.database.errors, "error")}.`
			);
			for (const span of r.spans) {
				lines.push(
					"",
					`- ${span.kind}, ${span.durationMs}ms${span.error ? `, failed: ${span.error}` : ""}`
				);
				if (span.statement)
					lines.push("", fence(span.statement, "sql"));
			}
		}
	} else {
		lines.push(
			`${focus.reportKind} report at ${iso(focus.ts)}${focus.page ? ` on ${focus.page}` : ""} (user-provided):`,
			"",
			quote(focus.message)
		);
	}
	if (exported.replay.url) lines.push("", `Replay: ${exported.replay.url}`);

	if (exported.timeline.length > 0) {
		lines.push("", "## Timeline around the focus", "");
		for (const entry of exported.timeline)
			lines.push(
				`- ${formatOffset(entry.offsetMs)} ${entry.kind}${entry.focus ? " (focus)" : ""}: ${entry.summary}`
			);
	}
	if (exported.reports.length > 0) {
		lines.push("", "## Linked user reports", "");
		for (const report of exported.reports)
			lines.push(
				`${report.kind} report at ${iso(report.ts)}:`,
				"",
				quote(report.message),
				""
			);
	}
	if (exported.notes.length > 0) {
		lines.push("", "## Investigation notes", "");
		for (const note of exported.notes)
			lines.push(`- ${iso(note.createdAt)}: ${note.body}`);
	}
	if (exported.links.length > 0) {
		lines.push("", "## Tickets and pull requests", "");
		for (const link of exported.links) lines.push(`- ${link}`);
	}
	if (exported.recovery) {
		const r = exported.recovery;
		lines.push(
			"",
			"## Recovery",
			"",
			`${recoveryVerdicts[r.verdict] ?? r.verdict}: ${r.affectedBefore} of ${r.sessionsBefore} replay sessions affected before resolution, ${r.affectedAfter} of ${r.sessionsAfter} since.`
		);
	}
	lines.push("", "## Not captured", "");
	for (const gap of exported.notCaptured) lines.push(`- ${gap}`);
	return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}
