import { appBasepath } from "../../mount";
import { acceptInvitationSchema } from "../../../contracts/organizations";
export function invitationPath(basepath = appBasepath) {
	return `${basepath.replace(/\/$/, "")}/invitations`;
}
export function invitationLink(
	origin: string,
	token: string,
	basepath = appBasepath
) {
	const url = new URL(invitationPath(basepath), origin);
	url.hash = token;
	return url.toString();
}

const KEY = "organization-invitation";
let currentToken: string | undefined;
let initialized = false;
// Capture before the router or replay recorder sees the invitation URL.
// sessionStorage survives sign-in redirects without placing the token in URLs.
export function captureInvitationLink(basepath = appBasepath) {
	if (
		window.location.pathname !== invitationPath(basepath) ||
		!window.location.hash
	)
		return;
	const token = acceptInvitationSchema.shape.token.safeParse(
		window.location.hash.slice(1)
	);
	initialized = true;
	currentToken = token.success ? token.data : undefined;
	window.history.replaceState(
		window.history.state,
		"",
		window.location.pathname + window.location.search
	);
	try {
		if (currentToken) sessionStorage.setItem(KEY, currentToken);
		else sessionStorage.removeItem(KEY);
	} catch {
		// Storage can be disabled. Keep this invitation in memory for SPA navigation.
	}
}
export function invitationToken(): string | undefined {
	if (initialized) return currentToken;
	initialized = true;
	try {
		const parsed = acceptInvitationSchema.shape.token.safeParse(
			sessionStorage.getItem(KEY)
		);
		currentToken = parsed.success ? parsed.data : undefined;
	} catch {
		// A link captured in this tab still works without persistent storage.
	}
	return currentToken;
}
export function clearInvitationToken() {
	currentToken = undefined;
	initialized = true;
	try {
		sessionStorage.removeItem(KEY);
	} catch {
		// The in-memory token is cleared even when storage is unavailable.
	}
}
