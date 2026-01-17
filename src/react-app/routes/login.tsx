import {
	Link,
	createFileRoute,
	useNavigate,
} from "@tanstack/react-router";
import { useState } from "react";
import { authClient } from "../lib/authClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
	FieldSeparator,
	FieldError,
} from "@/components/ui/field";

const Route = createFileRoute("/login")({
	component: LoginPage,
});

function LoginPage() {
	const navigate = useNavigate();
	const sessionQuery = authClient.useSession();

	const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	if (sessionQuery.data?.user) {
		return (
			<section className="space-y-4">
				<div className="space-y-1">
					<h1 className="text-2xl font-semibold tracking-tight">
						You are signed in
					</h1>
					<p className="text-sm text-muted-foreground">
						{sessionQuery.data.user.email}
					</p>
				</div>
				<div className="flex flex-wrap items-center gap-3">
					<Button type="button" onClick={() => navigate({ to: "/" })}>
						Go home
					</Button>
					<Button
						type="button"
						variant="outline"
						onClick={async () => {
							await authClient.signOut();
						}}
					>
						Sign out
					</Button>
				</div>
			</section>
		);
	}

	async function handleEmailSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setIsSubmitting(true);

		try {
			if (mode === "sign-up") {
				const { error: signUpError } = await authClient.signUp.email({
					email,
					password,
					name,
				});
				if (signUpError) {
					setError(signUpError.message ?? "Sign up failed");
					return;
				}
			} else {
				const { error: signInError } = await authClient.signIn.email({
					email,
					password,
				});
				if (signInError) {
					setError(signInError.message ?? "Sign in failed");
					return;
				}
			}

			navigate({ to: "/" });
		} finally {
			setIsSubmitting(false);
		}
	}

	return (
		<section className="mx-auto w-full max-w-md">
			<FieldGroup className="rounded-xl border bg-card p-6">
				<div className="space-y-1 text-center">
					<h1 className="text-xl font-semibold tracking-tight">
						{mode === "sign-in" ? "Sign in" : "Create account"}
					</h1>
					<FieldDescription>
						{mode === "sign-in" ? (
							<>
								No account?{" "}
								<button
									type="button"
									className="underline underline-offset-4"
									onClick={() => setMode("sign-up")}
								>
									Sign up
								</button>
							</>
						) : (
							<>
								Already have an account?{" "}
								<button
									type="button"
									className="underline underline-offset-4"
									onClick={() => setMode("sign-in")}
								>
									Sign in
								</button>
							</>
						)}
					</FieldDescription>
				</div>

				<form className="space-y-4" onSubmit={handleEmailSubmit}>
					{mode === "sign-up" ? (
						<Field>
							<FieldLabel htmlFor="name">Name</FieldLabel>
							<Input
								id="name"
								autoComplete="name"
								value={name}
								onChange={(e) => setName(e.target.value)}
								required
							/>
						</Field>
					) : null}

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

					<Field>
						<div className="flex items-center justify-between gap-3">
							<FieldLabel htmlFor="password">Password</FieldLabel>
							{mode === "sign-in" ? (
								<Link
									to="/reset-password"
									search={{ token: undefined }}
									className="text-sm underline underline-offset-4"
								>
									Forgot password?
								</Link>
							) : null}
						</div>
						<Input
							id="password"
							type="password"
							autoComplete={
								mode === "sign-up"
									? "new-password"
									: "current-password"
							}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							required
						/>
					</Field>

					{error ? <FieldError>{error}</FieldError> : null}

					<div className="flex items-center gap-3">
						<Button
							className="w-full"
							type="submit"
							disabled={isSubmitting}
						>
							{isSubmitting
								? "Working..."
								: mode === "sign-in"
									? "Sign in"
									: "Sign up"}
						</Button>
					</div>
				</form>

				<FieldSeparator>Or</FieldSeparator>

				<Button
					type="button"
					variant="outline"
					disabled={isSubmitting}
					onClick={async () => {
						setError(null);
						setIsSubmitting(true);
						try {
							await authClient.signIn.social({
								provider: "google",
							});
						} catch (e) {
							setError(
								e instanceof Error ? e.message : String(e)
							);
						} finally {
							setIsSubmitting(false);
						}
					}}
				>
					Continue with Google
				</Button>
			</FieldGroup>
		</section>
	);
}

export { Route };
