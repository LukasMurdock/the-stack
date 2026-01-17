import * as React from "react";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { makeCoreDb } from "../bindings/d1/core/db";
import * as schema from "../bindings/d1/core/schema";
import { openAPI, haveIBeenPwned, admin, apiKey } from "better-auth/plugins";
import { VerifyEmail } from "./emails/verify-email";
import { sendEmail } from "./email/send-email";
import { renderEmail } from "./emails/render";

type AuthEnv = Env & {
	BETTER_AUTH_SECRET: string;
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	PRODUCT_NAME: string;
	EMAIL_FROM: string;
	RESEND_API_KEY?: string;
};

type ExecutionContextLike = { waitUntil(promise: Promise<unknown>): void };

/**
 * await waitUntilOrAwait(ctx, sendEmail(result).catch((e) => errorReporter.capture(e));
 */
function waitUntilOrAwait(
	ctx: ExecutionContextLike | undefined,
	promise: Promise<void>
): Promise<void> {
	if (ctx) {
		ctx.waitUntil(promise);
		return Promise.resolve();
	}
	return promise;
}

function createAuth(env: AuthEnv, ctx?: ExecutionContextLike) {
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
			disableSignUp: true,
			sendResetPassword: async ({ user, url }) => {
				if (!env.RESEND_API_KEY) {
					console.log("[email:log-only:url]", {
						type: "reset-password",
						to: user.email,
						url,
					});
				}

				await waitUntilOrAwait(
					ctx,
					sendEmail({
						resendApiKey: env.RESEND_API_KEY,
						from: env.EMAIL_FROM,
						to: user.email,
						subject: `Reset your password for ${env.PRODUCT_NAME}`,
						...(await renderEmail(
							React.createElement(VerifyEmail, {
								productName: env.PRODUCT_NAME,
								url,
							})
						)),
					}).catch((e) =>
						console.error("Error sending verification email", e)
					)
				);
			},
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
			apiKey({
				storage: "secondary-storage",
			}),
			haveIBeenPwned({
				customPasswordCompromisedMessage:
					"Please choose a more secure password.",
			}),
			openAPI(),
		],
		emailVerification: {
			sendVerificationEmail: async ({ user, url }) => {
				if (!env.RESEND_API_KEY) {
					console.log("[email:log-only:url]", {
						type: "verify-email",
						to: user.email,
						url,
					});
				}

				await waitUntilOrAwait(
					ctx,
					sendEmail({
						resendApiKey: env.RESEND_API_KEY,
						from: env.EMAIL_FROM,
						to: user.email,
						subject: `Verify your email for ${env.PRODUCT_NAME}`,
						...(await renderEmail(
							React.createElement(VerifyEmail, {
								productName: env.PRODUCT_NAME,
								url,
							})
						)),
					}).catch((e) =>
						console.error("Error sending verification email", e)
					)
				);
			},
		},
	});
}

export { createAuth };
export type { AuthEnv };
