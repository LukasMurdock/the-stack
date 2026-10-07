import { createAuthClient } from "better-auth/client";
import { observeTurretCapture } from "./lifecycle";

// This Astro entry uses the framework-independent client, without React or router imports.
const authClient = createAuthClient();

declare global {
	interface Window {
		__turretAutoStarted?: boolean;
	}
}

function start(): void {
	if (typeof window === "undefined") return;
	if (window.__turretAutoStarted) return;
	window.__turretAutoStarted = true;

	observeTurretCapture(authClient.$store.atoms.session);
}

start();

export {};
