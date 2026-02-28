import {
	Link,
	createFileRoute,
	useNavigate,
	useRouter,
} from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { authClient } from "../../lib/authClient";
import { ApiError } from "../../lib/apiClient";
import { turretHealthQueryOptions } from "../../queries/turretQueries";
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

const Route = createFileRoute("/_public/login")({
	validateSearch: (s: Record<string, unknown>) => {
		const redirect =
			typeof s.redirect === "string" ? s.redirect : undefined;
		return {
			...(redirect ? { redirect } : {}),
		};
	},
	component: LoginPage,
});

function safeRedirectTarget(href: string | undefined): string | null {
	if (!href) return null;
	try {
		const u = new URL(href, window.location.origin);
		if (u.origin !== window.location.origin) return null;
		// This SPA is mounted under /app
		if (!u.pathname.startsWith("/app")) return null;
		return u.toString();
	} catch {
		return null;
	}
}

function LoginPage() {
	const navigate = useNavigate();
	const router = useRouter();
	const sessionQuery = authClient.useSession();
	const search = Route.useSearch();
	const redirectTarget = safeRedirectTarget(search.redirect);
	const isTurretRedirect = Boolean(
		redirectTarget?.includes("/app/ts_admin/turret")
	);

	const turretAccessQuery = useQuery({
		...turretHealthQueryOptions,
		enabled: Boolean(sessionQuery.data?.user && isTurretRedirect),
	});

	const authPolicyQuery = useQuery({
		queryKey: ["auth", "policy"],
		queryFn: async () => {
			const res = await fetch("/api/health", { credentials: "include" });
			if (!res.ok) {
				throw new Error(`Failed to load auth policy (${res.status})`);
			}
			const data = (await res.json()) as {
				auth?: {
					signupMode?: "invite_only" | "open";
					selfSignUpEnabled?: boolean;
				};
			};
			const signupMode =
				data.auth?.signupMode === "open" ? "open" : "invite_only";
			const selfSignUpEnabled =
				typeof data.auth?.selfSignUpEnabled === "boolean"
					? data.auth.selfSignUpEnabled
					: signupMode === "open";
			return { signupMode, selfSignUpEnabled };
		},
		retry: false,
	});
	const selfSignUpEnabled = authPolicyQuery.data?.selfSignUpEnabled === true;

	const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");

	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);

	const showSignUp = selfSignUpEnabled;

	let authPolicyMessage = "Checking auth policy for this environment...";
	if (authPolicyQuery.isError) {
		authPolicyMessage =
			"Could not load sign-up policy. You can still sign in.";
	} else if (authPolicyQuery.isSuccess && selfSignUpEnabled) {
		authPolicyMessage =
			"Self-service sign-up is enabled in this environment.";
	} else if (authPolicyQuery.isSuccess) {
		authPolicyMessage =
			"Self-service sign-up is disabled. Accounts are created by admin bootstrap.";
	}

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
					{redirectTarget &&
					(!isTurretRedirect || turretAccessQuery.isSuccess) ? (
						<Button
							type="button"
							variant="outline"
							onClick={() => router.history.push(redirectTarget)}
						>
							Continue
						</Button>
					) : null}
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

				{isTurretRedirect && turretAccessQuery.isError ? (
					<div className="text-sm text-muted-foreground">
						{turretAccessQuery.error instanceof ApiError &&
						turretAccessQuery.error.status === 403
							? "You do not have admin access to Turret."
							: "Could not verify Turret access."}
					</div>
				) : null}
			</section>
		);
	}

	async function handleEmailSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setIsSubmitting(true);

		try {
			if (mode === "sign-up") {
				if (!showSignUp) {
					setError("Sign-up is not enabled in this environment.");
					return;
				}

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

			if (redirectTarget) {
				router.history.push(redirectTarget);
			} else {
				navigate({ to: "/" });
			}
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
					<FieldDescription>{authPolicyMessage}</FieldDescription>
					{showSignUp ? (
						<FieldDescription>
							{mode === "sign-in" ? (
								<>
									No account?{" "}
									<button
										type="button"
										className="underline underline-offset-4"
										onClick={() => setMode("sign-up")}
									>
										Create one
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
					) : null}
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
							disabled={isSubmitting || authPolicyQuery.isLoading}
						>
							{isSubmitting
								? "Working..."
								: mode === "sign-in"
									? "Sign in"
									: "Create account"}
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

export { Route, safeRedirectTarget };
