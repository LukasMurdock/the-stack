import {
	turretComplianceSchema,
	type TurretCompliance,
} from "@/contracts/turret-policy";
import { useDraftValue } from "@/react-app/hooks/useDraftValue";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";

import {
	turretComplianceMutation,
	turretComplianceQueryOptions,
	turretFeaturesMutation,
	turretFeaturesQueryOptions,
} from "../../../../features/turret/queries";
import type { TurretComplianceUpdate } from "../../../../features/turret/queries";

const Route = createFileRoute("/ts_admin/turret/settings/")({
	component: TurretSettingsPage,
});

// This page edits a subset of policy. The draft is also the update payload;
// settings without controls must survive saving it.
function editablePolicy(policy: TurretCompliance) {
	return {
		retentionDays: policy.retentionDays,
		rrweb: { maskAllInputs: policy.rrweb.maskAllInputs },
		console: { enabled: policy.console.enabled },
	} satisfies TurretComplianceUpdate;
}

function TurretSettingsPage() {
	const navigate = useNavigate();
	const qc = useQueryClient();

	const featuresQuery = useQuery(turretFeaturesQueryOptions);
	const complianceQuery = useQuery(turretComplianceQueryOptions);

	const featuresMutation = useMutation(turretFeaturesMutation(qc));

	const complianceMutation = useMutation(turretComplianceMutation(qc));

	const policy = complianceQuery.data?.policy;
	const {
		value: draft,
		setValue: setDraft,
		reset: resetDraft,
	} = useDraftValue(
		editablePolicy(policy ?? turretComplianceSchema.parse({})),
		policy?.version ?? "loading"
	);
	const [savedAt, setSavedAt] = useState<number | null>(null);

	const isDirty =
		policy != null &&
		JSON.stringify(editablePolicy(policy)) !== JSON.stringify(draft);

	async function saveCompliance() {
		setSavedAt(null);
		await complianceMutation.mutateAsync(draft);
		resetDraft();
		setSavedAt(Date.now());
	}

	return (
		<section className="space-y-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						Turret settings
					</h1>
					<p className="text-sm text-muted-foreground">
						Configure privacy and capture policy.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Button
						type="button"
						variant="outline"
						onClick={() => navigate({ to: "/ts_admin/turret" })}
					>
						Dashboard
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/ts_admin/turret/replay-sessions",
								search: {},
							})
						}
					>
						Replay sessions
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={() =>
							navigate({
								to: "/ts_admin/turret/issues",
								search: {},
							})
						}
					>
						Issues
					</Button>
				</div>
			</div>

			<div className="grid gap-3 lg:grid-cols-2">
				<Card>
					<CardHeader>
						<CardTitle>Privacy</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						<div className="flex items-start justify-between gap-4">
							<div className="space-y-1">
								<Label htmlFor="storeUserEmail">
									Store user email
								</Label>
								<div className="text-xs text-muted-foreground">
									If disabled, new replay sessions will not
									persist emails. Existing stored emails are
									not deleted.
								</div>
							</div>
							<Switch
								id="storeUserEmail"
								disabled={
									featuresQuery.isLoading ||
									featuresMutation.isPending
								}
								checked={Boolean(
									featuresQuery.data?.features.storeUserEmail
								)}
								onCheckedChange={(checked) =>
									featuresMutation.mutate({
										storeUserEmail: checked,
									})
								}
							/>
						</div>
					</CardContent>
				</Card>

				<Card>
					<CardHeader>
						<CardTitle>Capture policy</CardTitle>
					</CardHeader>
					<CardContent className="space-y-4">
						{complianceQuery.isLoading ? (
							<div className="text-sm text-muted-foreground">
								Loading…
							</div>
						) : complianceQuery.isError ? (
							<div className="text-sm text-muted-foreground">
								Failed to load policy.
							</div>
						) : (
							<>
								<div className="space-y-2">
									<Label htmlFor="retentionDays">
										Retention days
									</Label>
									<Input
										id="retentionDays"
										type="number"
										min={
											turretComplianceSchema.shape.retentionDays.unwrap()
												.minValue ?? undefined
										}
										max={
											turretComplianceSchema.shape.retentionDays.unwrap()
												.maxValue ?? undefined
										}
										disabled={complianceMutation.isPending}
										value={draft.retentionDays}
										onChange={(e) =>
											setDraft((d) => ({
												...d,
												retentionDays: Number(
													e.target.value || 0
												),
											}))
										}
									/>
									<div className="text-xs text-muted-foreground">
										Controls how long Turret keeps replay
										session data.
									</div>
								</div>

								<Separator />

								<div className="flex items-start justify-between gap-4">
									<div className="space-y-1">
										<Label htmlFor="maskAllInputs">
											Mask all inputs
										</Label>
										<div className="text-xs text-muted-foreground">
											Hides keystrokes and form values in
											rrweb.
										</div>
									</div>
									<Switch
										id="maskAllInputs"
										disabled={complianceMutation.isPending}
										checked={draft.rrweb.maskAllInputs}
										onCheckedChange={(checked) =>
											setDraft((d) => ({
												...d,
												rrweb: {
													...d.rrweb,
													maskAllInputs: checked,
												},
											}))
										}
									/>
								</div>

								<div className="flex items-start justify-between gap-4">
									<div className="space-y-1">
										<Label htmlFor="consoleEnabled">
											Console capture
										</Label>
										<div className="text-xs text-muted-foreground">
											Capture client console logs for
											replay sessions.
										</div>
									</div>
									<Switch
										id="consoleEnabled"
										disabled={complianceMutation.isPending}
										checked={draft.console.enabled}
										onCheckedChange={(checked) =>
											setDraft((d) => ({
												...d,
												console: {
													...d.console,
													enabled: checked,
												},
											}))
										}
									/>
								</div>

								<div className="flex items-center justify-between gap-3 pt-2">
									<div className="text-xs text-muted-foreground">
										{savedAt
											? `Saved ${new Date(savedAt).toLocaleTimeString()}`
											: isDirty
												? "Unsaved changes"
												: ""}
									</div>
									<Button
										type="button"
										disabled={
											!isDirty ||
											complianceMutation.isPending
										}
										onClick={saveCompliance}
									>
										Save policy
									</Button>
								</div>
							</>
						)}
					</CardContent>
				</Card>
			</div>
		</section>
	);
}

export { Route };
