import { passwordSchema } from "../../../contracts/auth";
import * as React from "react";
import { useNavigate, useRouter } from "@tanstack/react-router";
import { authClient } from "../../auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldError,
} from "@/components/ui/field";

export function PasswordResetPage({
	token,
	invalidToken,
}: {
	token?: string;
	invalidToken?: boolean;
}) {
	const navigate = useNavigate();
	const router = useRouter();

	const [email, setEmail] = React.useState("");
	const [password, setPassword] = React.useState("");
	const [confirm, setConfirm] = React.useState("");
	const [error, setError] = React.useState<string | null>(
		invalidToken
			? "This reset link is invalid or expired. Request a new one."
			: null
	);
	const [isSubmitting, setIsSubmitting] = React.useState(false);
	const [requestSent, setRequestSent] = React.useState(false);

	const isResettingPassword = Boolean(token);

	async function handleRequestReset(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setRequestSent(false);

		setIsSubmitting(true);
		try {
			const redirectTo = new URL(
				router.buildLocation({ to: "/reset-password", search: {} })
					.href,
				window.location.origin
			).toString();

			const { error: requestError } =
				await authClient.requestPasswordReset({
					email,
					redirectTo,
				});

			if (requestError) {
				setError(
					requestError.message ?? "Could not request password reset"
				);
				return;
			}

			setRequestSent(true);
		} finally {
			setIsSubmitting(false);
		}
	}

	async function handleSubmitNewPassword(e: React.FormEvent) {
		e.preventDefault();
		setError(null);

		if (!token) {
			setError("Missing token. Please use the link from your email.");
			return;
		}

		const validated = passwordSchema.safeParse(password);
		if (!validated.success) {
			setError(
				validated.error.issues[0]?.message ?? "Choose a valid password."
			);
			return;
		}

		if (password !== confirm) {
			setError("Passwords do not match.");
			return;
		}

		setIsSubmitting(true);
		try {
			const { error: resetError } = await authClient.resetPassword({
				newPassword: password,
				token,
			});

			if (resetError) {
				setError(resetError.message ?? "Could not reset password");
				return;
			}

			navigate({ to: "/login", search: {} });
		} finally {
			setIsSubmitting(false);
		}
	}

	return (
		<section className="mx-auto w-full max-w-md">
			<FieldGroup className="rounded-xl border bg-card p-6">
				<div className="space-y-1 text-center">
					<h1 className="text-xl font-semibold tracking-tight">
						Reset password
					</h1>
					<FieldDescription>
						{isResettingPassword
							? "Choose a new password for your account."
							: "We will email you a link to reset your password."}
					</FieldDescription>
				</div>

				{isResettingPassword ? (
					<form
						className="space-y-4"
						onSubmit={handleSubmitNewPassword}
					>
						<Field>
							<FieldLabel htmlFor="password">
								New password
							</FieldLabel>
							<Input
								id="password"
								type="password"
								autoComplete="new-password"
								minLength={
									passwordSchema.minLength ?? undefined
								}
								maxLength={
									passwordSchema.maxLength ?? undefined
								}
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								required
							/>
						</Field>

						<Field>
							<FieldLabel htmlFor="confirm">
								Confirm password
							</FieldLabel>
							<Input
								id="confirm"
								type="password"
								autoComplete="new-password"
								minLength={
									passwordSchema.minLength ?? undefined
								}
								maxLength={
									passwordSchema.maxLength ?? undefined
								}
								value={confirm}
								onChange={(e) => setConfirm(e.target.value)}
								required
							/>
						</Field>

						{error ? <FieldError>{error}</FieldError> : null}

						<Button
							className="w-full"
							type="submit"
							disabled={isSubmitting}
						>
							{isSubmitting ? "Working..." : "Set new password"}
						</Button>
					</form>
				) : (
					<form className="space-y-4" onSubmit={handleRequestReset}>
						<Field>
							<FieldLabel htmlFor="email">Email</FieldLabel>
							<Input
								id="email"
								type="email"
								autoComplete="email"
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								required
							/>
						</Field>

						{requestSent ? (
							<FieldDescription className="text-center">
								If an account exists for that email, you will
								receive a reset link shortly.
							</FieldDescription>
						) : null}

						{error ? <FieldError>{error}</FieldError> : null}

						<Button
							className="w-full"
							type="submit"
							disabled={isSubmitting}
						>
							{isSubmitting ? "Working..." : "Email reset link"}
						</Button>
					</form>
				)}
			</FieldGroup>
		</section>
	);
}
