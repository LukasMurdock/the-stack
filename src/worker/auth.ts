import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { makeCoreDb } from "../bindings/d1/core/db";
import * as schema from "../bindings/d1/core/schema";
import { openAPI, haveIBeenPwned, admin, bearer } from "better-auth/plugins";
import { sendAuthEmail } from "./email/auth-email";
import type { EmailEnvironment } from "./email/send-email";
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

function createAuth(
	env: AuthEnv,
	ctx?: ObservabilityContext,
	requestId?: string
) {
	const selfSignUpEnabled = isSelfSignUpEnabled(env.AUTH_SIGNUP_MODE);

	return betterAuth({
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
		secondaryStorage: {
			get: async (key) => {
				return await env.CORE_KV.get(key);
			},
			set: async (key, value, ttl) => {
				if (ttl)
					await env.CORE_KV.put(key, value, { expirationTtl: ttl });
				else await env.CORE_KV.put(key, value);
			},
			delete: async (key) => {
				await env.CORE_KV.delete(key);
			},
		},
		user: { modelName: "auth_user" },
		session: { modelName: "auth_session" },
		account: { modelName: "auth_account" },
		verification: { modelName: "auth_verification" },
		emailAndPassword: {
			enabled: true,
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
		socialProviders:
			env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						google: {
							clientId: env.GOOGLE_CLIENT_ID,
							clientSecret: env.GOOGLE_CLIENT_SECRET,
						},
					}
				: {},
		plugins: [
			admin({
				adminRoles: ["admin"],
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
