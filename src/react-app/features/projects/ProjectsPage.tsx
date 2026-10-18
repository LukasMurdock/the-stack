import { can } from "@/features/organizations/policy";
import { createProjectSchema } from "../../../features/projects/contracts";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { projectsQuery, createProjectMutation } from "./queries";
import { projectCopy as copy } from "./copy";
import { organizationQuery } from "../organizations/queries";
import { FormDialog } from "../../forms/FormDialog";
import { MutationFeedback } from "../../forms/feedback";
import { Pagination } from "../../ui/Pagination";
import { Unit, unitRowStaticClass } from "../../ui/Unit";
import { rowsState } from "../../ui/unitState";
import { useWorkflowOutcome } from "../turret/outcomes";
import { useFlag } from "../../flags";

// On this screen the user is here to see the organization's projects;
// editors and owners also start new ones.
export function ProjectsPage({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId: string;
}) {
	const [offset, setOffset] = useState(0);
	const { projects, page } = useSuspenseQuery(
		projectsQuery(userId, organizationId, offset)
	).data;
	const { organization } = useSuspenseQuery(
		organizationQuery(userId, organizationId)
	).data;
	// Unfinished work ships dark: the count appears only where Flagship
	// serves projects-total on (see "Feature flags" in AGENTS.md).
	const showTotal = useFlag("projects-total", { userId, organizationId });
	return (
		<div className="space-y-3">
			<Unit
				title={copy.projects}
				meta={
					showTotal
						? copy.projectCount(page.total, organization.name)
						: undefined
				}
				action={
					can(organization.role, "edit") && (
						<CreateProject
							userId={userId}
							organizationId={organizationId}
							onCreated={() => setOffset(0)}
						/>
					)
				}
				state={rowsState(projects.length, copy.noProjects)}
			>
				<ul className="-mx-3">
					{projects.map((project) => (
						<li key={project.id} className={unitRowStaticClass}>
							<div className="min-w-0 flex-1 space-y-0.5">
								<h3 className="font-semibold break-words">
									{project.name}
								</h3>
								{project.description && (
									<p className="text-sm whitespace-pre-wrap break-words text-muted-foreground">
										{project.description}
									</p>
								)}
							</div>
						</li>
					))}
				</ul>
			</Unit>
			<Pagination page={page} onPage={setOffset} />
		</div>
	);
}

function CreateProject({
	userId,
	organizationId,
	onCreated,
}: {
	userId: string;
	organizationId: string;
	onCreated: () => void;
}) {
	const queryClient = useQueryClient();
	const create = useMutation(
		createProjectMutation(queryClient, userId, organizationId)
	);
	// An attempt starts when someone begins filling in the form.
	const outcome = useWorkflowOutcome("project.create");

	return (
		<FormDialog
			triggerLabel={copy.newProject}
			title={copy.newProject}
			onClosed={() => create.reset()}
		>
			{(close) => (
				<ProjectForm
					pending={create.isPending}
					error={create.error}
					onFocus={outcome.start}
					onSubmit={(fields) =>
						create.mutate(
							{
								name: String(fields.get("name") ?? ""),
								description: String(
									fields.get("description") ?? ""
								),
							},
							{
								onSuccess: () => {
									outcome.succeeded();
									close();
									onCreated();
								},
								onError: outcome.failed,
							}
						)
					}
				/>
			)}
		</FormDialog>
	);
}

function ProjectForm({
	pending,
	error,
	onFocus,
	onSubmit,
}: {
	pending: boolean;
	error: unknown;
	onFocus: () => void;
	onSubmit: (fields: FormData) => void;
}) {
	return (
		<form
			className="space-y-4"
			onFocus={onFocus}
			onSubmit={(event) => {
				event.preventDefault();
				onSubmit(new FormData(event.currentTarget));
			}}
		>
			<fieldset disabled={pending} className="space-y-4">
				<Field>
					<FieldLabel htmlFor="project-name">{copy.name}</FieldLabel>
					<Input
						id="project-name"
						name="name"
						required
						className="h-11"
						maxLength={
							createProjectSchema.shape.name.maxLength ??
							undefined
						}
					/>
				</Field>
				<Field>
					<FieldLabel htmlFor="project-description">
						{copy.description}
					</FieldLabel>
					<Textarea
						id="project-description"
						name="description"
						maxLength={
							createProjectSchema.shape.description.maxLength ??
							undefined
						}
					/>
				</Field>
				<Button type="submit" size="lg" className="w-full">
					{pending ? copy.creating : copy.create}
				</Button>
			</fieldset>
			<MutationFeedback error={error} />
		</form>
	);
}
