import type { InferRequestType } from "hono/client";
import { invitationPath } from "./invitationToken";
import { registerInvitationSchema } from "../../../contracts/organizations";
import { Link } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { apiClient, jsonOrThrow } from "../../api";
import { acknowledgementSchema } from "../../../contracts/organizations";
import { MutationFeedback } from "../../forms/feedback";

export function InvitationRegistration({
	token,
	onRegistered,
}: {
	token: string;
	onRegistered: () => Promise<unknown>;
}) {
	const register = useMutation({
		mutationFn: async (
			fields: Omit<
				InferRequestType<
					typeof apiClient.invitations.register.$post
				>["json"],
				"token"
			>
		) =>
			jsonOrThrow(
				await apiClient.invitations.register.$post({
					json: { token, ...fields },
				}),
				acknowledgementSchema
			),
		onSuccess: onRegistered,
	});
	return (
		<section className="max-w-lg space-y-4">
			<h1 className="text-2xl font-semibold">Join an organization</h1>
			{token ? (
				<>
					<p>
						Already have an account?{" "}
						<Link
							to="/login"
							search={{ redirect: invitationPath() }}
							className="underline"
						>
							Sign in
						</Link>{" "}
						with your invited email address.
					</p>
					<p>
						Or create an account with that email address, then
						verify it to join.
					</p>
					<form
						className="space-y-3"
						onSubmit={(event) => {
							event.preventDefault();
							const fields = new FormData(event.currentTarget);
							register.mutate({
								name: String(fields.get("name") ?? ""),
								email: String(fields.get("email") ?? ""),
								password: String(fields.get("password") ?? ""),
							});
						}}
					>
						<fieldset
							disabled={register.isPending}
							className="space-y-3"
						>
							<label htmlFor="invitation-name">Name</label>
							<Input
								id="invitation-name"
								name="name"
								autoComplete="name"
								required
								maxLength={
									registerInvitationSchema.shape.name
										.maxLength ?? undefined
								}
							/>
							<label htmlFor="invitation-email">Email</label>
							<Input
								id="invitation-email"
								name="email"
								type="email"
								autoComplete="email"
								required
								maxLength={
									registerInvitationSchema.shape.email
										.maxLength ?? undefined
								}
							/>
							<label htmlFor="invitation-password">
								Password
							</label>
							<Input
								id="invitation-password"
								name="password"
								type="password"
								autoComplete="new-password"
								required
								minLength={
									registerInvitationSchema.shape.password
										.minLength ?? undefined
								}
								maxLength={
									registerInvitationSchema.shape.password
										.maxLength ?? undefined
								}
							/>
							<Button type="submit">Create account</Button>
						</fieldset>
						<MutationFeedback error={register.error} />
					</form>
				</>
			) : (
				<p>
					Open the invitation link shared by your organization owner.
				</p>
			)}
		</section>
	);
}
