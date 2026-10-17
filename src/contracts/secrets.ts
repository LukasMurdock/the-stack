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
	readonly description: string;
};

// Secrets Store holds values of up to 1,024 bytes; anything longer is not a
// value this app stored.
export const SECRET_VALUE_BYTES_MAX = 1_024;

export const workerSecrets = {
	BETTER_AUTH_SECRET: {
		requirement: "required",
		lengthMin: 32,
		description: "Signs Better Auth sessions and tokens.",
	},
	BOOTSTRAP_SECRET: {
		requirement: "optional",
		lengthMin: 1,
		description: "Authorizes POST /api/internal/bootstrap-admin once.",
	},
	TURRET_SIGNING_KEY: {
		requirement: "optional",
		lengthMin: 1,
		description: "Signs Turret upload tokens; without it Turret is basic.",
	},
	RESEND_API_KEY: {
		requirement: "optional",
		lengthMin: 1,
		description: "Resend API key, used when EMAIL_TRANSPORT=resend.",
	},
	GOOGLE_CLIENT_ID: {
		requirement: "optional",
		lengthMin: 1,
		description: "Google sign-in, together with GOOGLE_CLIENT_SECRET.",
	},
	GOOGLE_CLIENT_SECRET: {
		requirement: "optional",
		lengthMin: 1,
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
