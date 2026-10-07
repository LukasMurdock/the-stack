import { can } from "@/features/organizations/policy";
import { createProjectSchema } from "../../../features/projects/contracts";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { projectsQuery, createProjectMutation } from "./queries";
import { organizationQuery } from "../organizations/queries";
import { Pagination } from "../organizations/Pagination";
import { MutationFeedback } from "../../forms/feedback";
export function ProjectsPage({
	userId,
	organizationId,
}: {
	userId: string;
	organizationId: string;
}) {
	const [offset, setOffset] = useState(0);
	const { projects } = useSuspenseQuery(
		projectsQuery(userId, organizationId, offset)
	).data;
	const { organization } = useSuspenseQuery(
		organizationQuery(userId, organizationId)
	).data;
	return (
		<section className="space-y-6">
			<h1 className="text-2xl font-semibold">Projects</h1>
			<ul className="divide-y rounded-lg border">
				{projects.map((project) => (
					<li key={project.id} className="space-y-1 p-4">
						<h2 className="font-medium">{project.name}</h2>
						<p className="whitespace-pre-wrap break-words text-sm">
							{project.description}
						</p>
					</li>
				))}
			</ul>
			{!projects.length && <p>No projects on this page.</p>}
			<Pagination
				offset={offset}
				count={projects.length}
				onPage={setOffset}
			/>
			{can(organization.role, "edit") && (
				<CreateProject
					userId={userId}
					organizationId={organizationId}
					onCreated={() => setOffset(0)}
				/>
			)}
		</section>
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
	const form = useRef<HTMLFormElement>(null);
	const queryClient = useQueryClient();
	const create = useMutation(
		createProjectMutation(queryClient, userId, organizationId)
	);

	return (
		<form
			ref={form}
			className="max-w-lg space-y-3"
			onSubmit={(event) => {
				event.preventDefault();
				const fields = new FormData(event.currentTarget);
				create.mutate(
					{
						name: String(fields.get("name") ?? ""),
						description: String(fields.get("description") ?? ""),
					},
					{
						onSuccess: () => {
							form.current?.reset();
							onCreated();
						},
					}
				);
			}}
		>
			<h2 className="text-lg font-medium">Create a project</h2>
			<fieldset disabled={create.isPending} className="space-y-3">
				<label htmlFor="project-name">Project name</label>
				<Input
					id="project-name"
					name="name"
					required
					maxLength={
						createProjectSchema.shape.name.maxLength ?? undefined
					}
				/>
				<label htmlFor="project-description">Description</label>
				<Textarea
					id="project-description"
					name="description"
					maxLength={
						createProjectSchema.shape.description.maxLength ??
						undefined
					}
				/>
				<Button type="submit">
					{create.isPending ? "Creating…" : "Create project"}
				</Button>
			</fieldset>
			<MutationFeedback
				error={create.error}
				success={create.isSuccess ? "Project created." : undefined}
			/>
		</form>
	);
}
