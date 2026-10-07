import { createOrganizationSchema } from "../../../../contracts/organizations";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MutationFeedback } from "../../../forms/feedback";
import {
	organizationsQuery,
	createOrganizationMutation,
} from "../../../features/organizations/queries";
import { Pagination } from "../../../features/organizations/Pagination";
export const Route = createFileRoute("/_authenticated/organizations/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(organizationsQuery(context.userId)),
	component: OrganizationsPage,
});
function OrganizationsPage() {
	const { userId } = Route.useRouteContext();
	const [offset, setOffset] = useState(0);
	const { organizations } = useSuspenseQuery(
		organizationsQuery(userId, offset)
	).data;
	const form = useRef<HTMLFormElement>(null);
	const queryClient = useQueryClient();
	const create = useMutation(createOrganizationMutation(queryClient, userId));

	return (
		<section className="space-y-6">
			<h1 className="text-2xl font-semibold">Organizations</h1>
			<ul className="divide-y rounded-lg border">
				{organizations.map((organization) => (
					<li
						key={organization.id}
						className="flex flex-wrap justify-between gap-3 p-4"
					>
						<Link
							to="/organizations/$organizationId/members"
							params={{ organizationId: organization.id }}
							className="underline"
						>
							{organization.name}
						</Link>
						<span className="capitalize">{organization.role}</span>
					</li>
				))}
			</ul>
			{!organizations.length && <p>No organizations on this page.</p>}
			<Pagination
				offset={offset}
				count={organizations.length}
				onPage={setOffset}
			/>
			<form
				ref={form}
				className="max-w-lg space-y-3"
				onSubmit={(event) => {
					event.preventDefault();
					create.mutate(
						{
							name: String(
								new FormData(event.currentTarget).get("name") ??
									""
							),
						},
						{
							onSuccess: () => {
								form.current?.reset();
								setOffset(0);
							},
						}
					);
				}}
			>
				<h2 className="text-lg font-medium">Create an organization</h2>
				<fieldset disabled={create.isPending} className="space-y-3">
					<label htmlFor="organization-name">Organization name</label>
					<Input
						id="organization-name"
						name="name"
						required
						maxLength={
							createOrganizationSchema.shape.name.maxLength ??
							undefined
						}
					/>
					<Button type="submit">
						{create.isPending ? "Creating…" : "Create organization"}
					</Button>
				</fieldset>
				<MutationFeedback
					error={create.error}
					success={
						create.isSuccess ? "Organization created." : undefined
					}
				/>
			</form>
		</section>
	);
}
