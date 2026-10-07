import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useState, type FormEvent } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

import {
	turretIssuePrioritySchema,
	turretIssueStatusSchema,
} from "@/contracts/turret";

import { issuePriorityLabels, issueStatusLabels } from "../issueSearch";
import { describeIssueLink } from "../issueLinks";
import {
	turretAssigneesQueryOptions,
	turretIssueActivityQueryOptions,
	turretIssueRecoveryQueryOptions,
	turretIssueTrackingMutation,
	type TurretAssignee,
	type TurretIssueActivity,
	type TurretIssueRecovery,
} from "../queries";

const UNASSIGNED = "unassigned";

function useAssignees() {
	const query = useQuery(turretAssigneesQueryOptions);
	const byId = new Map(
		(query.data?.assignees ?? []).map((user) => [user.id, user])
	);
	return {
		assignees: query.data?.assignees ?? [],
		currentUserId: query.data?.currentUserId ?? null,
		// Former administrators keep their attribution by ID.
		nameOf: (userId: string) => {
			const user: TurretAssignee | undefined = byId.get(userId);
			return user ? user.name || user.email : userId;
		},
	};
}

export function IssueOwner(props: {
	assigneeId: string | null;
	disabled: boolean;
	onAssign: (assigneeId: string | null) => void;
}) {
	const { assignees, currentUserId, nameOf } = useAssignees();
	const items = [
		{ value: UNASSIGNED, label: "Unassigned" },
		...assignees.map((user) => ({
			value: user.id,
			label: user.name || user.email,
		})),
		// An owner who is no longer an administrator stays visible.
		...(props.assigneeId &&
		!assignees.some((user) => user.id === props.assigneeId)
			? [{ value: props.assigneeId, label: nameOf(props.assigneeId) }]
			: []),
	];
	return (
		<div className="flex flex-wrap items-center gap-2">
			<span className="text-xs text-muted-foreground">Owner</span>
			<div className="min-w-[200px]">
				<Select
					items={items}
					value={props.assigneeId ?? UNASSIGNED}
					disabled={props.disabled}
					onValueChange={(value) =>
						props.onAssign(
							value === UNASSIGNED || value === null
								? null
								: String(value)
						)
					}
				>
					<SelectTrigger aria-label="Owner">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{items.map((item) => (
							<SelectItem key={item.value} value={item.value}>
								{item.label}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			{currentUserId && props.assigneeId !== currentUserId ? (
				<Button
					type="button"
					size="sm"
					variant="outline"
					disabled={props.disabled}
					onClick={() => props.onAssign(currentUserId)}
				>
					Assign to me
				</Button>
			) : null}
		</div>
	);
}

export function IssueLinks(props: {
	fingerprint: string;
	links: Array<{ id: string; url: string }>;
}) {
	const queryClient = useQueryClient();
	const mutation = useMutation(
		turretIssueTrackingMutation(queryClient, props.fingerprint)
	);
	const [url, setUrl] = useState("");

	function add(event: FormEvent) {
		event.preventDefault();
		const trimmed = url.trim();
		if (!trimmed) return;
		mutation.mutate(
			{ action: "addLink", url: trimmed },
			{ onSuccess: () => setUrl("") }
		);
	}

	return (
		<div className="space-y-2">
			<div className="text-xs text-muted-foreground">
				Tickets and pull requests
			</div>
			{props.links.length > 0 ? (
				<ul className="space-y-1">
					{props.links.map((link) => {
						const { label, kind } = describeIssueLink(link.url);
						return (
							<li
								key={link.id}
								className="flex flex-wrap items-center gap-2 text-sm"
							>
								<a
									href={link.url}
									target="_blank"
									rel="noreferrer"
									className="inline-flex items-center gap-1 underline underline-offset-4"
								>
									{label}
									<ExternalLink
										className="size-3"
										aria-hidden="true"
									/>
								</a>
								{kind !== "link" ? (
									<Badge variant="outline">{kind}</Badge>
								) : null}
								<Button
									type="button"
									size="xs"
									variant="ghost"
									disabled={mutation.isPending}
									aria-label={`Remove ${label}`}
									onClick={() =>
										mutation.mutate({
											action: "removeLink",
											linkId: link.id,
										})
									}
								>
									Remove
								</Button>
							</li>
						);
					})}
				</ul>
			) : null}
			<form className="flex flex-wrap gap-2" onSubmit={add}>
				<Input
					type="url"
					placeholder="https://github.com/org/repo/pull/123"
					aria-label="Ticket or pull request URL"
					value={url}
					onChange={(event) => setUrl(event.target.value)}
					className="min-w-[260px] flex-1"
				/>
				<Button
					type="submit"
					variant="outline"
					disabled={mutation.isPending || !url.trim()}
				>
					Add link
				</Button>
			</form>
			{mutation.isError ? (
				<div className="text-sm text-destructive">
					{mutation.error.message}
				</div>
			) : null}
		</div>
	);
}

function formatChance(chance: number) {
	return chance < 0.01 ? "under 1%" : `about ${Math.round(chance * 100)}%`;
}

function sessions(count: number) {
	return `${count.toLocaleString()} replay ${count === 1 ? "session" : "sessions"}`;
}

function recoveryMessage(recovery: TurretIssueRecovery) {
	const { before, after } = recovery;
	const rate = `${before.affected.toLocaleString()} of ${sessions(before.sessions)}`;
	const expected = recovery.expectedAffected ?? 0;
	switch (recovery.verdict) {
		case "likely_fixed":
			return `Likely fixed. Before resolution the issue affected ${rate}. At that rate, about ${Math.round(expected)} of the ${sessions(after.sessions)} since should have been affected, and none were. If nothing had changed, that would happen by chance ${formatChance(recovery.chanceUnchanged ?? 0)} of the time.`;
		case "insufficient_traffic":
			return `Not confirmed yet. Before resolution the issue affected ${rate}. At that rate, the ${sessions(after.sessions)} since would show it ${expected.toFixed(1)} times on average, too few to tell whether it's fixed.`;
		case "recurring":
			return `Still occurring: ${after.affected.toLocaleString()} of ${sessions(after.sessions)} since resolution were affected.`;
		case "no_baseline":
			return "Recovery can't be measured: no replay sessions in the week before resolution show this issue. Check that the affected flow works.";
	}
}

export function IssueRecovery(props: { fingerprint: string }) {
	const query = useQuery(turretIssueRecoveryQueryOptions(props.fingerprint));
	const recovery = query.data?.recovery;
	if (!recovery) return null;
	return (
		<div
			className={
				recovery.verdict === "likely_fixed"
					? "rounded-md border border-emerald-600/40 bg-emerald-600/5 p-3 text-sm"
					: "rounded-md border p-3 text-sm"
			}
		>
			<div className="font-medium">Recovery</div>
			<p className="mt-1 text-muted-foreground">
				{recoveryMessage(recovery)}
			</p>
			{recovery.resolvedInVersionId ? (
				<p className="mt-1 text-xs text-muted-foreground">
					Only sessions from deployments after{" "}
					<span className="font-mono">
						{recovery.resolvedInVersionId.slice(0, 8)}
					</span>{" "}
					count toward recovery.
				</p>
			) : null}
		</div>
	);
}

function describeActivity(
	entry: TurretIssueActivity,
	nameOf: (userId: string) => string
) {
	const { detail } = entry;
	switch (entry.kind) {
		case "note":
			return null;
		case "status": {
			const status = turretIssueStatusSchema.safeParse(detail.status);
			if (detail.resolveIn === "next_deployment")
				return "marked it Resolved in next deployment";
			return `marked it ${status.success ? issueStatusLabels[status.data] : String(detail.status)}`;
		}
		case "priority": {
			const priority = turretIssuePrioritySchema.safeParse(
				detail.priority
			);
			return `set priority to ${priority.success ? issuePriorityLabels[priority.data] : String(detail.priority)}`;
		}
		case "assignee":
			return typeof detail.assigneeId === "string"
				? `assigned it to ${nameOf(detail.assigneeId)}`
				: "unassigned it";
		case "link_added":
			return `linked ${describeIssueLink(String(detail.url)).label}`;
		case "link_removed":
			return `removed ${describeIssueLink(String(detail.url)).label}`;
	}
}

export function IssueActivity(props: { fingerprint: string }) {
	const queryClient = useQueryClient();
	const activityQuery = useQuery(
		turretIssueActivityQueryOptions(props.fingerprint)
	);
	const mutation = useMutation(
		turretIssueTrackingMutation(queryClient, props.fingerprint)
	);
	const { nameOf } = useAssignees();
	const [note, setNote] = useState("");

	function addNote(event: FormEvent) {
		event.preventDefault();
		if (!note.trim()) return;
		mutation.mutate(
			{ action: "note", body: note },
			{ onSuccess: () => setNote("") }
		);
	}

	const activity = activityQuery.data?.activity ?? [];
	return (
		<Card>
			<CardHeader>
				<CardTitle>Activity</CardTitle>
			</CardHeader>
			<CardContent className="space-y-4">
				<form className="space-y-2" onSubmit={addNote}>
					<Textarea
						placeholder="Add an investigation note: what you found, what you tried, what's next."
						aria-label="Investigation note"
						value={note}
						maxLength={5000}
						onChange={(event) => setNote(event.target.value)}
					/>
					<div className="flex items-center gap-3">
						<Button
							type="submit"
							disabled={mutation.isPending || !note.trim()}
						>
							Add note
						</Button>
						{mutation.isError ? (
							<span className="text-sm text-destructive">
								{mutation.error.message}
							</span>
						) : null}
					</div>
				</form>
				{activityQuery.isError ? (
					<div className="text-sm text-destructive">
						Failed to load activity.
					</div>
				) : activity.length === 0 ? (
					<div className="text-sm text-muted-foreground">
						No notes or changes yet.
					</div>
				) : (
					<ol className="space-y-3">
						{activity.map((entry) => {
							const description = describeActivity(entry, nameOf);
							return (
								<li key={entry.id} className="text-sm">
									<div className="text-xs text-muted-foreground">
										<span className="font-medium text-foreground">
											{nameOf(entry.actorId)}
										</span>{" "}
										{description ?? "added a note"} ·{" "}
										{new Date(
											entry.createdAt
										).toLocaleString()}
									</div>
									{entry.kind === "note" ? (
										<p className="mt-1 rounded-md bg-muted p-3 break-words whitespace-pre-wrap">
											{String(entry.detail.body)}
										</p>
									) : null}
								</li>
							);
						})}
					</ol>
				)}
			</CardContent>
		</Card>
	);
}
