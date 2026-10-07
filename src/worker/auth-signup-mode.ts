import { z } from "zod";

export const authSignupModeSchema = z.enum(["invite_only", "open"]);
type AuthSignupMode = z.infer<typeof authSignupModeSchema>;

function resolveAuthSignupMode(raw: string | undefined): AuthSignupMode {
	const normalized = raw?.trim().toLowerCase();
	const parsed = authSignupModeSchema.safeParse(normalized);
	return parsed.success ? parsed.data : "invite_only";
}

function isOpenSignupMode(mode: AuthSignupMode): boolean {
	return mode === "open";
}

function isSelfSignUpEnabled(raw: string | undefined): boolean {
	return isOpenSignupMode(resolveAuthSignupMode(raw));
}

export { resolveAuthSignupMode, isSelfSignUpEnabled, isOpenSignupMode };
export type { AuthSignupMode };
