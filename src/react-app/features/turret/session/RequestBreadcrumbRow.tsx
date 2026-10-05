import { useId, type RefObject } from "react";
import { ExternalLink } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";

import { CopyButton } from "../CopyButton";
import type {
	TurretRequestBreadcrumb,
	TurretRequestSpan,
} from "../../../lib/turretApi";
import {
	jumpReplayToTimestamp,
	type RrwebPlayerInstance,
} from "./replayPlayer";

const CLOUDFLARE_TRACES_URL =
	"https://dash.cloudflare.com/?to=/:account/workers-and-pages/observability/traces";

// The dashboard link can't be pre-filtered, and traces are head-sampled.
const TRACE_LINK_HINT =
	"Opens Cloudflare Workers traces in a new tab. Search there for the Ray ID or request ID. Traces are sampled, so this request may not have one.";

export function RequestBreadcrumbRow(props: {
	breadcrumb: TurretRequestBreadcrumb;
	ts: number;
	spans: TurretRequestSpan[];
	replayReady: boolean;
	playerRef: RefObject<RrwebPlayerInstance | null>;
}) {
	const b = props.breadcrumb;
	const traceHintId = useId();

	return (
		<div className="rounded-md border bg-card p-3">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="min-w-0">
					<div className="text-sm font-medium">
						{b.method} {b.path}
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						{b.status} · {b.durationMs}ms · d1 {b.d1QueriesCount}q/
						{b.d1QueriesTimeMs}ms
					</div>
					<div className="mt-1 text-xs text-muted-foreground">
						{new Date(props.ts).toLocaleString()}
					</div>
					<dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs text-muted-foreground">
						<dt>Request ID</dt>
						<dd className="truncate font-mono select-all">
							{b.requestId}
						</dd>
						{b.rayId ? (
							<>
								<dt>Ray ID</dt>
								<dd className="truncate font-mono select-all">
									{b.rayId}
								</dd>
							</>
						) : null}
					</dl>
				</div>
				<div className="flex flex-wrap items-center gap-2">
					<CopyButton
						value={b.requestId}
						label="Copy request ID"
						noun="Request ID"
					/>
					{b.rayId ? (
						<CopyButton
							value={b.rayId}
							label="Copy Ray ID"
							noun="Ray ID"
						/>
					) : null}
					<a
						href={CLOUDFLARE_TRACES_URL}
						target="_blank"
						rel="noreferrer"
						className={buttonVariants({
							variant: "outline",
							size: "xs",
						})}
						title={TRACE_LINK_HINT}
						aria-describedby={traceHintId}
					>
						Search Cloudflare traces
						<ExternalLink aria-hidden="true" />
					</a>
					<span id={traceHintId} className="sr-only">
						{TRACE_LINK_HINT}
					</span>
					<details className="text-xs">
						<summary className="cursor-pointer select-none text-muted-foreground">
							D1 spans
						</summary>
						{props.spans.length === 0 ? (
							<div className="mt-2 text-muted-foreground">
								No spans
							</div>
						) : (
							<div className="mt-2 space-y-2">
								{props.spans.map((s) => (
									<div
										key={s.id}
										className="rounded-md border bg-background p-2"
									>
										<div className="text-xs">
											{s.kind} · {s.db} · {s.durationMs}ms
										</div>
										{s.sqlShape ? (
											<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px]">
												{s.sqlShape}
											</pre>
										) : null}
										{s.errorMessage ? (
											<pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-[11px] text-destructive">
												{s.errorMessage}
											</pre>
										) : null}
									</div>
								))}
							</div>
						)}
					</details>
					<Button
						type="button"
						variant="outline"
						size="xs"
						disabled={!props.replayReady}
						onClick={() =>
							jumpReplayToTimestamp(
								props.playerRef.current,
								props.ts
							)
						}
					>
						Jump
					</Button>
				</div>
			</div>
		</div>
	);
}
