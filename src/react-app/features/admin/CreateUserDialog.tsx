import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
	accountRoleSchema,
	createUserSchema,
	createdUserResponseSchema,
	type CreateUserInput,
} from "../../../contracts/admin-users";
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
import { apiClient, jsonOrThrow } from "../../api";
import { MutationFeedback } from "../../forms/feedback";
import { CopyButton } from "../turret/CopyButton";

type CreatedUser = ReturnType<typeof createdUserResponseSchema.parse>;

// The starting password lives only in this state. Closing the dialog drops it.
type DialogState =
	| { readonly kind: "form" }
	| { readonly kind: "created"; readonly created: CreatedUser };

const roleDescriptions = {
	user: "Signs in and joins organizations they are invited to.",
	admin: "Also manages users and Turret. Give this sparingly.",
} satisfies Record<CreateUserInput["role"], string>;

export function CreateUserDialog() {
	const [open, setOpen] = useState(false);
	const [state, setState] = useState<DialogState>({ kind: "form" });
	return (
		<Dialog
			open={open}
			onOpenChange={setOpen}
			// Drop the password once the closing animation has finished.
			onOpenChangeComplete={(isOpen) => {
				if (!isOpen) setState({ kind: "form" });
			}}
		>
			<DialogTrigger render={<Button type="button" />}>
				Create user
			</DialogTrigger>
			<DialogContent>
				{state.kind === "form" ? (
					<CreateUserForm
						onCreated={(created) =>
							setState({ kind: "created", created })
						}
					/>
				) : (
					<StartingPassword
						created={state.created}
						onDone={() => setOpen(false)}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CreateUserForm(props: { onCreated: (created: CreatedUser) => void }) {
	const queryClient = useQueryClient();
	const [role, setRole] = useState<CreateUserInput["role"]>("user");
	const create = useMutation({
		mutationFn: async (input: CreateUserInput) =>
			jsonOrThrow(
				await apiClient.internal.users.$post({ json: input }),
				createdUserResponseSchema
			),
		onSuccess: async (created) => {
			props.onCreated(created);
			await queryClient.invalidateQueries({
				queryKey: ["ts_admin", "users"],
			});
		},
	});
	const nameMax = createUserSchema.shape.name.maxLength ?? undefined;
	const emailMax = createUserSchema.shape.email.maxLength ?? undefined;
	return (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				const fields = new FormData(event.currentTarget);
				create.mutate({
					name: String(fields.get("name") ?? ""),
					email: String(fields.get("email") ?? ""),
					role,
					emailVerification:
						fields.get("emailVerified") === "on"
							? "verified"
							: "unverified",
				});
			}}
		>
			<DialogHeader>
				<DialogTitle>Create user</DialogTitle>
				<DialogDescription>
					No email is sent. You get a starting password to give the
					person yourself.
				</DialogDescription>
			</DialogHeader>
			<fieldset disabled={create.isPending} className="space-y-3">
				<label className="block space-y-1">
					<span className="text-sm font-medium">Name</span>
					<Input name="name" required maxLength={nameMax} autoFocus />
				</label>
				<label className="block space-y-1">
					<span className="text-sm font-medium">Email</span>
					<Input
						name="email"
						type="email"
						required
						maxLength={emailMax}
					/>
				</label>
				<RoleField role={role} onChange={setRole} />
				<EmailVerifiedField />
			</fieldset>
			<MutationFeedback error={create.error} />
			<DialogFooter>
				<Button type="submit" disabled={create.isPending}>
					{create.isPending ? "Creating…" : "Create user"}
				</Button>
			</DialogFooter>
		</form>
	);
}

function RoleField(props: {
	role: CreateUserInput["role"];
	onChange: (role: CreateUserInput["role"]) => void;
}) {
	return (
		<div className="space-y-1">
			<label className="block space-y-1">
				<span className="text-sm font-medium">Role</span>
				<select
					className="block h-9 w-full rounded-md border bg-background px-2 text-sm"
					value={props.role}
					onChange={(event) => {
						const parsed = accountRoleSchema.safeParse(
							event.target.value
						);
						if (parsed.success) props.onChange(parsed.data);
					}}
				>
					{accountRoleSchema.options.map((option) => (
						<option key={option} value={option}>
							{option}
						</option>
					))}
				</select>
			</label>
			<p className="text-xs text-muted-foreground">
				{roleDescriptions[props.role]}
			</p>
		</div>
	);
}

function EmailVerifiedField() {
	return (
		<div className="space-y-1">
			<label className="flex items-center gap-2 text-sm font-medium">
				<input type="checkbox" name="emailVerified" defaultChecked />
				Mark email as verified
			</label>
			<p className="text-xs text-muted-foreground">
				Lets them accept invitations without a verification email. Only
				for an address you know is theirs.
			</p>
		</div>
	);
}

function StartingPassword(props: { created: CreatedUser; onDone: () => void }) {
	const { user, startingPassword } = props.created;
	return (
		<div className="space-y-4">
			<DialogHeader>
				<DialogTitle>User created</DialogTitle>
				<DialogDescription>
					Give {user.email} this starting password. It is shown only
					now and is not stored anywhere you can see it again.
				</DialogDescription>
			</DialogHeader>
			{/* rr-block: session replay records a placeholder, never the value. */}
			<div className="rr-block space-y-2">
				<label className="block space-y-1">
					<span className="text-sm font-medium">
						Starting password
					</span>
					<Input
						readOnly
						value={startingPassword}
						className="font-mono"
						onFocus={(event) => event.currentTarget.select()}
					/>
				</label>
				<CopyButton
					value={startingPassword}
					label="Copy password"
					noun="Password"
				/>
			</div>
			<p className="text-xs text-muted-foreground">
				They sign in at /app/login with {user.email}. If it is lost, set
				a new one from the user's page.
			</p>
			<DialogFooter>
				<Button type="button" onClick={props.onDone}>
					Done
				</Button>
			</DialogFooter>
		</div>
	);
}
