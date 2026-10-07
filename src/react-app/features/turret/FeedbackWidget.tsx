import {
	turretFeedbackKindSchema,
	turretFeedbackBodySchema,
} from "@/contracts/turret";
import { useSyncExternalStore, useState } from "react";

import { getTurretContext, subscribeTurretSession } from "./context";
import { submitUserFeedback, type TurretFeedbackKind } from "./feedback";

import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";

const feedbackKindLabels = {
	bug: "Bug",
	idea: "Idea",
	praise: "Praise",
	other: "Other",
} satisfies Record<TurretFeedbackKind, string>;

function TurretFeedbackWidget() {
	const [open, setOpen] = useState(false);
	const [kind, setKind] = useState<TurretFeedbackKind>("bug");
	const [message, setMessage] = useState("");
	const [contact, setContact] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);
	const [submitting, setSubmitting] = useState(false);

	const sessionActive = useSyncExternalStore(
		subscribeTurretSession,
		() => Boolean(getTurretContext()),
		() => false
	);

	function handleOpenChange(nextOpen: boolean) {
		setOpen(nextOpen);
		if (!nextOpen) {
			setError(null);
			setSent(false);
		}
	}

	async function onSubmit() {
		setError(null);
		setSubmitting(true);
		try {
			await submitUserFeedback({ kind, message, contact });
			setSent(true);
			setMessage("");
			setContact("");
		} catch (err) {
			setError(
				err instanceof Error ? err.message : "Failed to send feedback"
			);
		} finally {
			setSubmitting(false);
		}
	}

	return (
		<div className="fixed right-4 bottom-4 z-40">
			<Dialog open={open} onOpenChange={handleOpenChange}>
				<DialogTrigger
					render={<Button type="button" variant="outline" />}
				>
					Feedback
				</DialogTrigger>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Send feedback</DialogTitle>
						<DialogDescription>
							Attached to your current session. Replay is included
							when available.
						</DialogDescription>
					</DialogHeader>

					{sent ? (
						<div className="rounded-md border bg-muted/20 p-3 text-sm">
							<div className="font-medium">Thanks!</div>
							<div className="mt-1 text-muted-foreground">
								Feedback sent successfully.
							</div>
						</div>
					) : null}

					{!sessionActive ? (
						<div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
							A Turret session is not active. Sign in and refresh
							to enable session-linked feedback.
						</div>
					) : null}

					<div className="space-y-3">
						<div>
							<div className="text-sm font-medium">Type</div>
							<Select
								value={kind}
								onValueChange={(v) => {
									const parsed =
										turretFeedbackKindSchema.safeParse(v);
									if (parsed.success) setKind(parsed.data);
								}}
							>
								<SelectTrigger className="mt-1">
									<SelectValue placeholder="Select type" />
								</SelectTrigger>
								<SelectContent>
									{turretFeedbackKindSchema.options.map(
										(value) => (
											<SelectItem
												key={value}
												value={value}
											>
												{feedbackKindLabels[value]}
											</SelectItem>
										)
									)}
								</SelectContent>
							</Select>
						</div>

						<div>
							<div className="text-sm font-medium">Message</div>
							<textarea
								className="mt-1 min-h-[120px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
								placeholder="What happened? What did you expect?"
								maxLength={
									turretFeedbackBodySchema.shape.message
										.maxLength ?? undefined
								}
								value={message}
								onChange={(e) => setMessage(e.target.value)}
								disabled={!sessionActive || submitting}
							/>
							<div className="mt-1 text-xs text-muted-foreground">
								Keep it short; you can include steps to
								reproduce.
							</div>
						</div>

						<div>
							<div className="text-sm font-medium">
								Contact (optional)
							</div>
							<Input
								className="mt-1"
								placeholder="email@domain.com"
								maxLength={
									turretFeedbackBodySchema.shape.contact.unwrap()
										.maxLength ?? undefined
								}
								value={contact}
								onChange={(e) => setContact(e.target.value)}
								disabled={!sessionActive || submitting}
							/>
							<div className="mt-1 text-xs text-muted-foreground">
								Only include this if you want a reply.
							</div>
						</div>
					</div>

					{error ? (
						<div className="text-sm text-destructive">{error}</div>
					) : null}

					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							onClick={() => handleOpenChange(false)}
							disabled={submitting}
						>
							Close
						</Button>
						<Button
							type="button"
							onClick={onSubmit}
							disabled={
								!sessionActive || submitting || !message.trim()
							}
						>
							{submitting ? "Sending…" : "Send"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

export { TurretFeedbackWidget };
