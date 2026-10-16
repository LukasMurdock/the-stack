// The users prepare-e2e seeds into every browser run. Browser specs, `pnpm
// shot --e2e` and `pnpm api --e2e` sign in as these, so they live in one place.

export const FIXTURE_PERSONAS = ["owner", "viewer", "admin"] as const;
export type FixturePersona = (typeof FIXTURE_PERSONAS)[number];

// Not a secret: it only opens throwaway state under .wrangler/e2e/<port>.
export const FIXTURE_PASSWORD = "Browser-test-password-123!";

export function fixtureEmail(persona: FixturePersona): string {
	return `${persona}@example.test`;
}

export function fixtureRole(persona: FixturePersona): "admin" | "user" {
	if (persona === "admin") return "admin";
	return "user";
}

export function isFixturePersona(value: string): value is FixturePersona {
	return FIXTURE_PERSONAS.some((persona) => persona === value);
}
