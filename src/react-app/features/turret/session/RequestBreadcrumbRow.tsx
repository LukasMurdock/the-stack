import type { RefObject } from "react";

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

export function RequestBreadcrumbRow(props: {
	breadcrumb: TurretRequestBreadcrumb;
	ts: number;
	spans: TurretRequestSpan[];
	replayReady: boolean;
	playerRef: RefObject<RrwebPlayerInstance | null>;
}) {
	const b = props.breadcrumb;

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
						{new Date(props.ts).toLocaleString()} · {b.requestId}
					</div>
					{b.rayId ? (
						<div className="mt-1 text-xs text-muted-foreground">
							ray {b.rayId}
						</div>
					) : null}
				</div>
				<div className="flex items-center gap-2">
					{b.rayId ? (
						<>
							<button
								type="button"
								className="rounded-md border px-2.5 py-1 text-xs"
								onClick={() => {
									try {
										void navigator.clipboard.writeText(
											b.rayId ?? ""
										);
									} catch {
										// ignore
									}
								}}
							>
								Copy ray
							</button>
							<a
								href={CLOUDFLARE_TRACES_URL}
								target="_blank"
								rel="noreferrer"
								className="rounded-md border px-2.5 py-1 text-xs"
								title="Open Cloudflare Traces (search by ray id)"
							>
								Trace
							</a>
						</>
					) : null}
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
					<button
						type="button"
						className="rounded-md border px-2.5 py-1 text-xs"
						disabled={!props.replayReady}
						onClick={() =>
							jumpReplayToTimestamp(
								props.playerRef.current,
								props.ts
							)
						}
					>
						Jump
					</button>
				</div>
			</div>
		</div>
	);
}
