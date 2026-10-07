import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import type { TurretIssueReport } from "../queries";
import { useReplayPlayer } from "../session/useReplayPlayer";
import { ReplayCard, SessionTimeline } from "./ReplayEvidence";
import { REPLAY_LEAD_MS } from "./timeline";

// Opens a linked feedback report with its replay positioned just before the
// report and the replay session's evidence around it.
export function ReportInvestigation(props: {
	fingerprint: string;
	report: TurretIssueReport;
	// Replay position from the URL; defaults to just before the report.
	position: number | undefined;
	onPositionChange: (ts: number) => void;
}) {
	const { report } = props;
	const replaySessionId = report.replayAvailable ? report.sessionId : null;
	const startTs = props.position ?? report.ts - REPLAY_LEAD_MS;
	const {
		playerHostRef,
		status: replayStatus,
		ready: replayReady,
		consoleItems,
		seek,
	} = useReplayPlayer(replaySessionId, {
		startAt: { key: report.id, ts: startTs },
	});

	function jump(ts: number) {
		seek(ts);
		props.onPositionChange(ts);
	}

	return (
		<>
			<Card>
				<CardHeader>
					<div className="space-y-1">
						<CardTitle>Selected report</CardTitle>
						<p className="text-xs text-muted-foreground">
							A user's feedback report linked to this issue.
						</p>
					</div>
				</CardHeader>
				<CardContent className="space-y-3">
					<div className="flex flex-wrap items-center gap-2">
						<Badge variant="outline">{report.kind}</Badge>
						<span className="text-xs text-muted-foreground">
							{report.status} ·{" "}
							{new Date(report.ts).toLocaleString()}
						</span>
					</div>
					<p className="text-base break-words whitespace-pre-wrap">
						{report.message}
					</p>
					<dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
						{[
							["Reporter", report.userEmail ?? report.userId],
							["Contact", report.contact],
							["Page", report.url],
							["Replay session", report.sessionId],
						]
							.filter(([, value]) => value)
							.map(([label, value]) => (
								<div key={label} className="contents">
									<dt className="text-muted-foreground">
										{label}
									</dt>
									<dd className="truncate font-mono select-all">
										{value}
									</dd>
								</div>
							))}
					</dl>
				</CardContent>
			</Card>

			{replaySessionId ? (
				<>
					<ReplayCard
						sessionId={replaySessionId}
						startTs={startTs}
						focusLabel="report"
						playerHostRef={playerHostRef}
						status={replayStatus}
						ready={replayReady}
					/>
					<SessionTimeline
						sessionId={replaySessionId}
						focus={{
							kind: "feedback",
							id: report.id,
							ts: report.ts,
						}}
						fingerprint={props.fingerprint}
						matchedRequestId={null}
						consoleItems={consoleItems}
						replay={{ ready: replayReady, onJump: jump }}
					/>
				</>
			) : (
				<Card>
					<CardContent className="text-sm text-muted-foreground">
						This report's replay session has no playable replay or
						has expired.
					</CardContent>
				</Card>
			)}
		</>
	);
}
