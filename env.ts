import { defineEnv } from "void/env";
import { z } from "zod";

// Void checks required remote secret names before publication. Application
// services continue to receive raw Cloudflare bindings through Hono.
export default defineEnv({
	BETTER_AUTH_SECRET: z.string().min(32),
	BOOTSTRAP_SECRET: z.string().optional(),
	TURRET_SIGNING_KEY: z.string().optional(),
	RESEND_API_KEY: z.string().optional(),
	GOOGLE_CLIENT_ID: z.string().optional(),
	GOOGLE_CLIENT_SECRET: z.string().optional(),
});
