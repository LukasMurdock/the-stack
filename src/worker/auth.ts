import { adminAccountRoles } from "../features/auth/policy";
import { passwordSchema } from "../contracts/auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { makeCoreDb } from "../bindings/d1/core/db";
import * as schema from "../bindings/d1/core/schema";
import { openAPI, haveIBeenPwned, admin, bearer } from "better-auth/plugins";
import { sendAuthEmail } from "./email/auth-email";
import type { EmailEnvironment } from "./email/send-email";
import { createAuthStorage } from "./auth-storage";
import { isSelfSignUpEnabled } from "./auth-signup-mode";
import type { ObservabilityContext } from "./observability/tracing";

type AuthEnv = Env &
	EmailEnvironment & {
		BETTER_AUTH_SECRET: string;
		GOOGLE_CLIENT_ID?: string;
		GOOGLE_CLIENT_SECRET?: string;
		PRODUCT_NAME: string;
		AUTH_SIGNUP_MODE?: string;
	};

export function configuredGoogleProvider(
	env: Pick<AuthEnv, "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">
) {
	if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return undefined;
	return {
		clientId: env.GOOGLE_CLIENT_ID,
		clientSecret: env.GOOGLE_CLIENT_SECRET,
	};
}

function createAuth(
	env: AuthEnv,
	ctx?: ObservabilityContext,
	requestId?: string
) {
	const selfSignUpEnabled = isSelfSignUpEnabled(env.AUTH_SIGNUP_MODE);
	const google = configuredGoogleProvider(env);

	return betterAuth({
		baseURL: env.APP_URL,
		secret: env.BETTER_AUTH_SECRET,
		advanced: {
			defaultCookieAttributes: {
				path: "/",
				sameSite: "lax",
			},
		},
		database: drizzleAdapter(makeCoreDb(env.CORE_DB), {
			provider: "sqlite",
			schema: {
				...schema,
				user: schema.auth_user,
				session: schema.auth_session,
				account: schema.auth_account,
				verification: schema.auth_verification,
			},
		}),
		secondaryStorage: createAuthStorage(env.CORE_DB),
		user: { modelName: "auth_user" },
		session: { modelName: "auth_session" },
		account: { modelName: "auth_account" },
		verification: { modelName: "auth_verification" },
		emailAndPassword: {
			enabled: true,
			minPasswordLength: passwordSchema.minLength ?? undefined,
			maxPasswordLength: passwordSchema.maxLength ?? undefined,
			disableSignUp: !selfSignUpEnabled,
			sendResetPassword: ({ user, url }) =>
				sendAuthEmail({
					env,
					ctx,
					requestId,
					type: "reset-password",
					to: user.email,
					url,
				}),
		},
		socialProviders: google ? { google } : {},
		plugins: [
			admin({
				adminRoles: [...adminAccountRoles],
			}),
			bearer(),
			haveIBeenPwned({
				customPasswordCompromisedMessage:
					"Please choose a more secure password.",
			}),
			openAPI(),
		],
		emailVerification: {
			sendVerificationEmail: ({ user, url }) =>
				sendAuthEmail({
					env,
					ctx,
					requestId,
					type: "verify-email",
					to: user.email,
					url,
				}),
		},
	});
}

export { createAuth };
export type { AuthEnv };
