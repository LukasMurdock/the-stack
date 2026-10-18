import { OpenAPIHono, createRoute } from "@hono/zod-openapi";
import { eq } from "drizzle-orm";
import type { CoreDb } from "../../../bindings/d1/core/db";
import { auth_user } from "../../../bindings/d1/core/schema";
import {
	signInLinkResponseSchema,
	userTargetSchema,
} from "../../../contracts/admin-users";
import { ProductError } from "../../../features/shared/context";
import { createAuth } from "../../auth";
import { recordAdminSignInLinkSentEvent } from "../../observability/evlog";
import { emailReadiness } from "./readiness";
import {
	errorResponses,
	operationErrorHandler,
	requireAdmin,
	validationHook,
	type OperationEnv,
} from "./_shared/operation-http";

// One link per person per minute, so a double click or a stolen admin session
// cannot flood someone's inbox. KV's shortest expiry is also 60 seconds, so
// the record removes itself. KV is eventually consistent across locations:
// this bounds an administrator's repeated clicks, not a distributed attack.
export const SIGN_IN_LINK_COOLDOWN_SECONDS = 60;
const SIGN_IN_LINK_COOLDOWN_MS = SIGN_IN_LINK_COOLDOWN_SECONDS * 1_000;
const MS_PER_SECOND = 1_000;
// The React app's reset form, mounted under /app
// (src/react-app/features/auth/PasswordResetPage.tsx builds the same URL).
const RESET_PASSWORD_PATH = "/app/reset-password";

export function signInLinkCooldownKey(userId: string): string {
	return `admin:sign-in-link:${userId}`;
}

const app = new OpenAPIHono<OperationEnv>({ defaultHook: validationHook });
app.onError(operationErrorHandler);

// Under /internal/ so the OpenAPI document hides it from non-administrators.
const postSignInLink = createRoute({
	method: "post",
	path: "/internal/users/{userId}/sign-in-link",
	middleware: [requireAdmin] as const,
	request: { params: userTargetSchema },
	responses: {
		202: {
			description:
				"A link to set a password and sign in is being emailed to the user",
			content: {
				"application/json": { schema: signInLinkResponseSchema },
			},
		},
		...errorResponses,
	},
});

export const routes = app.openapi(postSignInLink, async (c) => {
	const { userId } = c.req.valid("param");
	const operation = c.get("operation");
	const email = emailReadiness(c.env);
	if (email.delivery === "unavailable")
		throw new ProductError(
			"unavailable",
			`Email cannot be sent: ${email.reason}`
		);
	const user = await findUser(operation.db, userId);
	if (user === undefined)
		throw new ProductError("not_found", "User not found.");
	const nowMs = Date.now();
	if (isBanned(user, nowMs))
		throw new ProductError(
			"conflict",
			`${user.email} is banned. Unban them before sending a sign-in link.`
		);
	const remainingSeconds = await cooldownRemainingSeconds(
		c.env.CORE_KV,
		userId,
		nowMs
	);
	if (remainingSeconds > 0) {
		c.header("Retry-After", String(remainingSeconds));
		throw new ProductError(
			"rate_limited",
			`A sign-in link was just sent to ${user.email}. Try again in ${remainingSeconds} seconds.`
		);
	}
	// Recorded before sending, so a concurrent second click is refused too.
	await c.env.CORE_KV.put(signInLinkCooldownKey(userId), String(nowMs), {
		expirationTtl: SIGN_IN_LINK_COOLDOWN_SECONDS,
	});
	const auth = createAuth(c.env, c.executionCtx, c.get("requestId"), {
		passwordResetEmail: "sign-in-link",
	});
	await sendSignInLink(auth, { appUrl: c.env.APP_URL, email: user.email });
	recordAdminSignInLinkSentEvent({
		actorId: operation.actor.userId,
		userId,
	});
	return c.json({ sentTo: user.email }, 202);
});

type TargetUser = {
	readonly email: string;
	readonly banned: boolean | null;
	readonly banExpires: Date | null;
};

async function findUser(
	db: CoreDb,
	userId: string
): Promise<TargetUser | undefined> {
	const [user] = await db
		.select({
			email: auth_user.email,
			banned: auth_user.banned,
			banExpires: auth_user.banExpires,
		})
		.from(auth_user)
		.where(eq(auth_user.id, userId))
		.limit(1);
	return user;
}

// Better Auth lifts a ban whose expiry has passed at the next sign-in.
function isBanned(user: TargetUser, nowMs: number): boolean {
	if (user.banned !== true) return false;
	if (user.banExpires === null) return true;
	return user.banExpires.getTime() > nowMs;
}

// The stored value is the send time in milliseconds. A value that does not
// parse (a hand edit) counts as no cooldown and is overwritten by this send.
async function cooldownRemainingSeconds(
	store: Pick<KVNamespace, "get">,
	userId: string,
	nowMs: number
): Promise<number> {
	const raw = await store.get(signInLinkCooldownKey(userId));
	if (raw === null) return 0;
	const sentAtMs = Number(raw);
	if (!Number.isSafeInteger(sentAtMs)) return 0;
	const remainingMs = sentAtMs + SIGN_IN_LINK_COOLDOWN_MS - nowMs;
	if (remainingMs <= 0) return 0;
	return Math.min(
		SIGN_IN_LINK_COOLDOWN_SECONDS,
		Math.ceil(remainingMs / MS_PER_SECOND)
	);
}

// Better Auth's own reset flow creates the one-hour, single-use token and
// calls sendResetPassword; the caller's instance sends it as "sign-in-link".
// No headers are forwarded: the admin session was checked by requireAdmin,
// and Better Auth's origin check applies only to browser requests.
async function sendSignInLink(
	auth: ReturnType<typeof createAuth>,
	target: { readonly appUrl: string; readonly email: string }
): Promise<void> {
	await auth.api.requestPasswordReset({
		body: {
			email: target.email,
			redirectTo: new URL(RESET_PASSWORD_PATH, target.appUrl).toString(),
		},
	});
}
