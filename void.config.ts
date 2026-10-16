import { defineConfig } from "void/config";
import { deploymentCloudflare } from "./config/cloudflare.mjs";

export default defineConfig({
	inference: {
		appType: "framework",
		build: "pnpm run build",
		// The adapter provisions every explicit binding, including two D1s.
		bindings: {
			db: false,
			kv: false,
			storage: false,
			email: deploymentCloudflare.vars.EMAIL_TRANSPORT === "cloudflare",
		},
	},
	email:
		deploymentCloudflare.vars.EMAIL_TRANSPORT === "cloudflare"
			? { from: deploymentCloudflare.vars.EMAIL_FROM }
			: undefined,
	routing: { isr: false },
	cloudflare: deploymentCloudflare,
});
