import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { passwordSchema } from "../../../contracts/auth";
import { authClient } from "../../auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Field,
	FieldDescription,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";

// Better Auth error codes this page words for people.
const CHANGE_PASSWORD_ERRORS: Record<string, string> = {
	INVALID_PASSWORD: "Your current password is incorrect.",
	CREDENTIAL_ACCOUNT_NOT_FOUND: "This account has no password to change.",
};

export function AccountPage() {
	const accounts = useQuery({
		queryKey: ["auth", "accounts"],
		retry: false,
		queryFn: async () => {
			const { data, error } = await authClient.listAccounts();
			if (error)
				throw new Error(
					error.message ?? "Could not load your sign-in methods."
				);
			return data;
		},
	});
	return (
		<section className="mx-auto w-full max-w-md">
			<FieldGroup className="rounded-xl border bg-card p-6">
				<div className="space-y-1">
					<h1 className="text-xl font-semibold tracking-tight">
						Change password
					</h1>
					<FieldDescription>
						Replace your password, for example a starting password
						an administrator gave you.
					</FieldDescription>
				</div>
				{accounts.isPending ? (
					<p className="text-sm text-muted-foreground">Loading...</p>
				) : accounts.isError ? (
					<FieldError>{accounts.error.message}</FieldError>
				) : accounts.data.some(
						(account) => account.providerId === "credential"
				  ) ? (
					<ChangePasswordForm />
				) : (
					<NoPassword />
				)}
			</FieldGroup>
		</section>
	);
}

type FormState =
	| { readonly kind: "editing" }
	| { readonly kind: "submitting" }
	| { readonly kind: "failed"; readonly message: string }
	| { readonly kind: "changed"; readonly signedOutOthers: boolean };

function ChangePasswordForm() {
	const [current, setCurrent] = React.useState("");
	const [next, setNext] = React.useState("");
	const [confirm, setConfirm] = React.useState("");
	const [revokeOtherSessions, setRevokeOtherSessions] = React.useState(true);
	const [state, setState] = React.useState<FormState>({ kind: "editing" });

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const validated = passwordSchema.safeParse(next);
		if (!validated.success)
			return setState({
				kind: "failed",
				message:
					validated.error.issues[0]?.message ??
					"Choose a valid password.",
			});
		if (next !== confirm)
			return setState({
				kind: "failed",
				message: "New passwords do not match.",
			});
		setState({ kind: "submitting" });
		const { error } = await authClient.changePassword({
			currentPassword: current,
			newPassword: next,
			revokeOtherSessions,
		});
		if (error)
			return setState({
				kind: "failed",
				message:
					(error.code && CHANGE_PASSWORD_ERRORS[error.code]) ??
					error.message ??
					"Could not change your password. Try again.",
			});
		setCurrent("");
		setNext("");
		setConfirm("");
		setState({ kind: "changed", signedOutOthers: revokeOtherSessions });
	}

	const bounds = {
		minLength: passwordSchema.minLength ?? undefined,
		maxLength: passwordSchema.maxLength ?? undefined,
	};
	return (
		<form className="space-y-4" onSubmit={handleSubmit}>
			<Field>
				<FieldLabel htmlFor="current-password">
					Current password
				</FieldLabel>
				<Input
					id="current-password"
					type="password"
					autoComplete="current-password"
					maxLength={bounds.maxLength}
					value={current}
					onChange={(e) => setCurrent(e.target.value)}
					required
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor="new-password">New password</FieldLabel>
				<Input
					id="new-password"
					type="password"
					autoComplete="new-password"
					{...bounds}
					value={next}
					onChange={(e) => setNext(e.target.value)}
					required
				/>
			</Field>
			<Field>
				<FieldLabel htmlFor="confirm-password">
					Confirm new password
				</FieldLabel>
				<Input
					id="confirm-password"
					type="password"
					autoComplete="new-password"
					{...bounds}
					value={confirm}
					onChange={(e) => setConfirm(e.target.value)}
					required
				/>
			</Field>
			<label className="flex items-center gap-2 text-sm font-medium">
				<input
					type="checkbox"
					checked={revokeOtherSessions}
					onChange={(e) => setRevokeOtherSessions(e.target.checked)}
				/>
				Sign out other sessions
			</label>
			{state.kind === "failed" ? (
				<FieldError>{state.message}</FieldError>
			) : null}
			{state.kind === "changed" ? (
				<p role="status" className="text-sm">
					Password changed.
					{state.signedOutOthers
						? " Your other sessions are signed out."
						: ""}
				</p>
			) : null}
			<Button
				className="w-full"
				type="submit"
				disabled={state.kind === "submitting"}
			>
				{state.kind === "submitting" ? "Working..." : "Change password"}
			</Button>
		</form>
	);
}

// Google-only accounts have no credential to change. Setting a first password
// goes through the emailed reset link, which proves the mailbox: Better Auth
// keeps setPassword server-only so a stolen session cannot add a password.
function NoPassword() {
	const router = useRouter();
	const session = authClient.useSession();
	const email = session.data?.user.email;
	const [state, setState] = React.useState<
		"idle" | "sending" | "sent" | "failed"
	>("idle");

	async function sendLink() {
		if (!email) return;
		setState("sending");
		const redirectTo = new URL(
			router.buildLocation({ to: "/reset-password", search: {} }).href,
			window.location.origin
		).toString();
		const { error } = await authClient.requestPasswordReset({
			email,
			redirectTo,
		});
		setState(error ? "failed" : "sent");
	}

	return (
		<div className="space-y-4 text-sm">
			<p>
				You sign in with another provider (such as Google), so this
				account has no password to change.
			</p>
			<p className="text-muted-foreground">
				To add one, we can email {email ?? "you"} a link to set a
				password.
			</p>
			{state === "sent" ? (
				<p role="status">
					Check your inbox for the link. If nothing arrives, ask an
					administrator.
				</p>
			) : null}
			{state === "failed" ? (
				<FieldError>Could not request the link. Try again.</FieldError>
			) : null}
			<Button
				type="button"
				variant="outline"
				disabled={!email || state === "sending"}
				onClick={sendLink}
			>
				{state === "sending" ? "Working..." : "Email me a link"}
			</Button>
		</div>
	);
}
