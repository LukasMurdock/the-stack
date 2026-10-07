import { useState } from "react";

import { Button } from "@/components/ui/button";

import { fetchInvestigationExport } from "../queries";
import { renderInvestigationMarkdown } from "./exportMarkdown";

type ExportState = "idle" | "working" | "copied" | "downloaded" | "failed";

// Exports the current investigation: Markdown for a ticket or coding agent,
// JSON for tools. Both are observed facts with links back to the evidence.
export function ExportInvestigation(props: {
	fingerprint: string;
	focus: { event?: string; report?: string };
}) {
	const [state, setState] = useState<ExportState>("idle");

	async function run(format: "markdown" | "json") {
		setState("working");
		try {
			const exported = await fetchInvestigationExport(
				props.fingerprint,
				props.focus
			);
			if (format === "markdown") {
				await navigator.clipboard.writeText(
					renderInvestigationMarkdown(exported)
				);
				setState("copied");
				return;
			}
			const url = URL.createObjectURL(
				new Blob([JSON.stringify(exported, null, 2)], {
					type: "application/json",
				})
			);
			const link = document.createElement("a");
			link.href = url;
			link.download = `turret-${props.fingerprint.replace(/[^a-zA-Z0-9-]+/g, "-").slice(0, 60)}.json`;
			link.click();
			URL.revokeObjectURL(url);
			setState("downloaded");
		} catch {
			setState("failed");
		}
	}

	return (
		<div className="flex flex-wrap items-center gap-2">
			<Button
				type="button"
				variant="outline"
				disabled={state === "working"}
				onClick={() => void run("markdown")}
			>
				Copy for coding agent
			</Button>
			<Button
				type="button"
				variant="outline"
				disabled={state === "working"}
				onClick={() => void run("json")}
			>
				Download JSON
			</Button>
			<span role="status" className="text-xs text-muted-foreground">
				{state === "copied"
					? "Copied the investigation as Markdown."
					: state === "downloaded"
						? "Downloaded the investigation."
						: state === "failed"
							? "Couldn't export the investigation."
							: ""}
			</span>
		</div>
	);
}
