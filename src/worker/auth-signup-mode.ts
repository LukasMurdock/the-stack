type AuthSignupMode = "invite_only" | "open";

function resolveAuthSignupMode(raw: string | undefined): AuthSignupMode {
	const normalized = raw?.trim().toLowerCase();
	if (normalized === "open") return "open";
	return "invite_only";
}

function isOpenSignupMode(mode: AuthSignupMode): boolean {
	return mode === "open";
}

function isSelfSignUpEnabled(raw: string | undefined): boolean {
	return isOpenSignupMode(resolveAuthSignupMode(raw));
}

export { resolveAuthSignupMode, isSelfSignUpEnabled, isOpenSignupMode };
export type { AuthSignupMode };
