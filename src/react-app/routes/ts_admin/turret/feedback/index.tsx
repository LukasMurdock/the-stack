import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { requireTurretAdmin } from "../../../../lib/requireTurretAdmin";
import {
	turretFeedbackQueryOptions,
	turretFeedbackStatusMutation,
} from "../../../../queries/turretQueries";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import type {
	TurretFeedbackStatus,
	TurretFeedbackKind,
} from "../../../../lib/turretApi";

const Route = createFileRoute("/ts_admin/turret/feedback/")({
	beforeLoad: requireTurretAdmin,
	component: TurretFeedbackPage,
});

function formatDate(ms: number): string {
	try {
		return new Date(ms).toLocaleString();
	} catch {
		return String(ms);
	}
}

function TurretFeedbackPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();

	// Anchor time for stable queryKey.
	const [now] = useState(() => Date.now());
	const [status, setStatus] = useState<TurretFeedbackStatus>("open");
	const [kind, setKind] = useState<TurretFeedbackKind | "all">("all");
	const [q, setQ] = useState("");
	const [offset, setOffset] = useState(0);
	const limit = 50;

	const queryInput = useMemo(
		() => ({
			status,
			kind: kind === "all" ? undefined : kind,
			q: q.trim() || undefined,
			from: now - 30 * 24 * 60 * 60 * 1000,
			to: now,
			limit,
			offset,
		}),
		[status, kind, q, now, limit, offset]
	);

	const feedbackQuery = useQuery(turretFeedbackQueryOptions(queryInput));

	const updateStatusMutation = useMutation({
		mutationFn: turretFeedbackStatusMutation,
		onSuccess: async () => {
			await qc.invalidateQueries({ queryKey: ["turret", "feedback"] });
			await qc.invalidateQueries({ queryKey: ["turret", "session"] });
		},
	});

	const rows = feedbackQuery.data?.feedback ?? [];

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						User Feedback
					</h1>
					<p className="text-sm text-muted-foreground">
						Session-linked feedback (last 30 days).
					</p>
				</div>
				<Button
					type="button"
					variant="outline"
					onClick={() => navigate({ to: "/ts_admin/turret" })}
				>
					Back to dashboard
				</Button>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Filters</CardTitle>
				</CardHeader>
				<CardContent className="flex flex-wrap items-center gap-2">
					<div className="min-w-[200px]">
						<Select
							value={status}
							onValueChange={(v) => {
								setStatus(v as TurretFeedbackStatus);
								setOffset(0);
							}}
						>
							<SelectTrigger>
								<SelectValue placeholder="Status" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="open">open</SelectItem>
								<SelectItem value="triaged">triaged</SelectItem>
								<SelectItem value="resolved">
									resolved
								</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<div className="min-w-[200px]">
						<Select
							value={kind}
							onValueChange={(v) => {
								setKind(v as any);
								setOffset(0);
							}}
						>
							<SelectTrigger>
								<SelectValue placeholder="Kind" />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="all">all</SelectItem>
								<SelectItem value="bug">bug</SelectItem>
								<SelectItem value="idea">idea</SelectItem>
								<SelectItem value="praise">praise</SelectItem>
								<SelectItem value="other">other</SelectItem>
							</SelectContent>
						</Select>
					</div>

					<Input
						className="min-w-[260px] flex-1"
						placeholder="Search message/url…"
						value={q}
						onChange={(e) => {
							setQ(e.target.value);
							setOffset(0);
						}}
					/>
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Feedback</CardTitle>
				</CardHeader>
				<CardContent>
					{feedbackQuery.isLoading ? (
						<div className="text-sm text-muted-foreground">
							Loading…
						</div>
					) : feedbackQuery.isError ? (
						<div className="text-sm text-destructive">
							Failed to load feedback.
						</div>
					) : rows.length === 0 ? (
						<div className="text-sm text-muted-foreground">
							No feedback.
						</div>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>When</TableHead>
									<TableHead>Kind</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Message</TableHead>
									<TableHead className="text-right">
										Actions
									</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{rows.map((r) => (
									<TableRow key={r.id}>
										<TableCell className="whitespace-nowrap text-sm text-muted-foreground">
											{formatDate(r.ts)}
										</TableCell>
										<TableCell>
											<Badge variant="secondary">
												{r.kind}
											</Badge>
										</TableCell>
										<TableCell>
											<Badge>{r.status}</Badge>
										</TableCell>
										<TableCell className="max-w-[520px]">
											<div
												className="truncate font-medium"
												title={r.message}
											>
												{r.message}
											</div>
											<div className="truncate text-xs text-muted-foreground">
												{r.userEmail ?? r.userId}
												{r.url ? ` · ${r.url}` : ""}
											</div>
										</TableCell>
										<TableCell className="text-right">
											<div className="inline-flex flex-wrap justify-end gap-2">
												<Button
													type="button"
													variant="outline"
													onClick={() =>
														navigate({
															to: "/ts_admin/turret/sessions/$sessionId",
															params: {
																sessionId:
																	r.sessionId,
															},
														})
													}
												>
													Open session
												</Button>
												<Button
													type="button"
													variant="outline"
													disabled={
														updateStatusMutation.isPending ||
														r.status === "triaged"
													}
													onClick={() =>
														updateStatusMutation.mutate(
															{
																id: r.id,
																status: "triaged",
															}
														)
													}
												>
													Triage
												</Button>
												<Button
													type="button"
													variant="outline"
													disabled={
														updateStatusMutation.isPending ||
														r.status === "resolved"
													}
													onClick={() =>
														updateStatusMutation.mutate(
															{
																id: r.id,
																status: "resolved",
															}
														)
													}
												>
													Resolve
												</Button>
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}

					{feedbackQuery.data ? (
						<div className="mt-4 flex items-center justify-end gap-2">
							<Button
								type="button"
								variant="outline"
								disabled={offset <= 0}
								onClick={() =>
									setOffset((v) => Math.max(0, v - limit))
								}
							>
								Prev
							</Button>
							<Button
								type="button"
								variant="outline"
								disabled={rows.length < limit}
								onClick={() => setOffset((v) => v + limit)}
							>
								Next
							</Button>
						</div>
					) : null}
				</CardContent>
			</Card>
		</section>
	);
}

export { Route };
