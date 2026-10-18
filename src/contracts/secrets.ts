// Every secret the Worker reads. Production stores them in Cloudflare Secrets
// Store (`secrets_store_secrets` bindings), never as plain Worker secrets: Void
// pins a live Worker's plain secrets and uploads through its own uploader,
// which cannot upload the FLAGS or ANALYTICS_SQL bindings. Local development
// and tests pass the same names as plain strings (.env, test fixtures).
// Dependency-free: the Worker, config/cloudflare.mjs and scripts import it.

export type SecretRequirement = "required" | "optional";

export type SecretSpec = {
	readonly requirement: SecretRequirement;
	// Shortest accepted value, in characters.
	readonly lengthMin: number;
	// True when any random value works because the app itself mints it
	// (`pnpm secret`, `pnpm secrets:switch create-secrets`); false for a
	// credential a provider issues.
	readonly generated: boolean;
	readonly description: string;
};

// Secrets Store holds values of up to 64 KiB (Wrangler's
// MAX_SECRET_VALUE_BYTES; the API rejects longer ones). Anything longer is not
// a value this app stored. A service-account JSON key (a few KB) fits.
export const SECRET_VALUE_BYTES_MAX = 65_536;

export const workerSecrets = {
	BETTER_AUTH_SECRET: {
		requirement: "required",
		lengthMin: 32,
		generated: true,
		description: "Signs Better Auth sessions and tokens.",
	},
	BOOTSTRAP_SECRET: {
		requirement: "optional",
		lengthMin: 1,
		generated: true,
		description: "Authorizes POST /api/internal/bootstrap-admin once.",
	},
	TURRET_SIGNING_KEY: {
		requirement: "optional",
		lengthMin: 1,
		generated: true,
		description: "Signs Turret upload tokens; without it Turret is basic.",
	},
	RESEND_API_KEY: {
		requirement: "optional",
		lengthMin: 1,
		generated: false,
		description: "Resend API key, used when EMAIL_TRANSPORT=resend.",
	},
	GOOGLE_CLIENT_ID: {
		requirement: "optional",
		lengthMin: 1,
		generated: false,
		description: "Google sign-in, together with GOOGLE_CLIENT_SECRET.",
	},
	GOOGLE_CLIENT_SECRET: {
		requirement: "optional",
		lengthMin: 1,
		generated: false,
		description: "Google sign-in, together with GOOGLE_CLIENT_ID.",
	},
} as const satisfies Readonly<Record<string, SecretSpec>>;

export type SecretName = keyof typeof workerSecrets;

export const SECRET_NAMES: readonly SecretName[] = [
	"BETTER_AUTH_SECRET",
	"BOOTSTRAP_SECRET",
	"TURRET_SIGNING_KEY",
	"RESEND_API_KEY",
	"GOOGLE_CLIENT_ID",
	"GOOGLE_CLIENT_SECRET",
];

export function isSecretName(name: string): name is SecretName {
	return Object.hasOwn(workerSecrets, name);
}

export function requiredSecretNames(): readonly SecretName[] {
	return SECRET_NAMES.filter(
		(name) => workerSecrets[name].requirement === "required"
	);
}

// The command that stores one secret for production. Wrangler prompts for
// the value, so it never reaches shell history.
export function secretCreateCommand(storeId: string, name: string): string {
	return `pnpm exec wrangler secrets-store secret create ${storeId} --name ${name} --scopes workers --remote`;
}
