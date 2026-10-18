import { createOrganizationSchema } from "../../../../contracts/organizations";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
	useMutation,
	useQueryClient,
	useSuspenseQuery,
} from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { FormDialog } from "../../../forms/FormDialog";
import { MutationFeedback } from "../../../forms/feedback";
import {
	organizationsQuery,
	createOrganizationMutation,
} from "../../../features/organizations/queries";
import {
	organizationCopy as copy,
	roleLabels,
} from "../../../features/organizations/copy";
import { PageHeader } from "../../../ui/PageHeader";
import { Pagination } from "../../../ui/Pagination";
import { Unit, unitRowClass } from "../../../ui/Unit";
import { rowsState } from "../../../ui/unitState";

export const Route = createFileRoute("/_authenticated/organizations/")({
	loader: ({ context }) =>
		context.queryClient.ensureQueryData(organizationsQuery(context.userId)),
	component: OrganizationsPage,
});

// On this screen the user is here to open one of their organizations, or
// start a new one.
function OrganizationsPage() {
	const { userId } = Route.useRouteContext();
	const [offset, setOffset] = useState(0);
	const { organizations, page } = useSuspenseQuery(
		organizationsQuery(userId, offset)
	).data;
	return (
		<div className="space-y-6">
			<PageHeader
				title={copy.organizations}
				action={<NewOrganization userId={userId} />}
			/>
			<Unit
				title={copy.yours}
				meta={
					page.total > 0
						? copy.organizationCount(page.total)
						: undefined
				}
				state={rowsState(organizations.length, copy.noOrganizations)}
			>
				{/* The whole row opens the organization. */}
				<ul className="-mx-3">
					{organizations.map((organization) => (
						<li key={organization.id}>
							<Link
								to="/organizations/$organizationId/members"
								params={{ organizationId: organization.id }}
								aria-label={organization.name}
								aria-describedby={`organization-${organization.id}`}
								className={unitRowClass}
							>
								<span className="min-w-0 flex-1 space-y-0.5">
									<span className="block truncate font-semibold">
										{organization.name}
									</span>
									<span
										id={`organization-${organization.id}`}
										className="block text-sm text-muted-foreground"
									>
										{roleLabels[organization.role]}
									</span>
								</span>
								<ChevronRight
									aria-hidden
									className="size-4 shrink-0 text-muted-foreground"
								/>
							</Link>
						</li>
					))}
				</ul>
			</Unit>
			<Pagination page={page} onPage={setOffset} />
		</div>
	);
}

// Creating one opens it, so there is nothing to confirm on this screen.
function NewOrganization({ userId }: { userId: string }) {
	const queryClient = useQueryClient();
	const create = useMutation(createOrganizationMutation(queryClient, userId));
	const navigate = useNavigate();
	return (
		<FormDialog
			triggerLabel={copy.newOrganization}
			title={copy.newOrganization}
			onClosed={() => create.reset()}
		>
			{(close) => (
				<form
					className="space-y-4"
					onSubmit={(event) => {
						event.preventDefault();
						const name = new FormData(event.currentTarget).get(
							"name"
						);
						create.mutate(
							{ name: String(name ?? "") },
							{
								onSuccess: ({ organization }) => {
									close();
									void navigate({
										to: "/organizations/$organizationId/members",
										params: {
											organizationId: organization.id,
										},
									});
								},
							}
						);
					}}
				>
					<fieldset disabled={create.isPending} className="space-y-4">
						<Field>
							<FieldLabel htmlFor="organization-name">
								{copy.name}
							</FieldLabel>
							<Input
								id="organization-name"
								name="name"
								required
								className="h-11"
								maxLength={
									createOrganizationSchema.shape.name
										.maxLength ?? undefined
								}
							/>
						</Field>
						<Button type="submit" size="lg" className="w-full">
							{create.isPending ? copy.creating : copy.create}
						</Button>
					</fieldset>
					<MutationFeedback error={create.error} />
				</form>
			)}
		</FormDialog>
	);
}
