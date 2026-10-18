import { useMutation } from "@tanstack/react-query";
import { signInLinkResponseSchema } from "../../../contracts/admin-users";
import { apiClient, jsonOrThrow } from "../../api";
import { useEmailConfiguration } from "./useEmailConfiguration";

export const signInLinkCopy = {
	action: "Send sign-in link",
	confirm: (email: string) =>
		`Email ${email} a link to set their password and sign in?`,
	sent: (email: string) => `Sign-in link sent to ${email}`,
	banned: "Banned users cannot be sent a sign-in link.",
	emailUnavailable: (reason: string) =>
		`Sign-in links cannot be sent until email is configured: ${reason}`,
};

export type SignInLinkTarget = {
	readonly userId: string;
	readonly email: string;
};
export type SignInLinkSent = ReturnType<typeof signInLinkResponseSchema.parse>;

// Admin → Users: email someone a link to set their password and sign in
// (POST /api/internal/users/{userId}/sign-in-link). Log-only environments
// stay enabled: the link is written to the server log there.
export function useSignInLink() {
	const email = useEmailConfiguration();
	const send = useMutation({
		mutationFn: async (target: SignInLinkTarget) =>
			jsonOrThrow(
				await apiClient.internal.users[":userId"]["sign-in-link"].$post(
					{ param: { userId: target.userId } }
				),
				signInLinkResponseSchema
			),
	});
	const unavailableReason =
		email?.delivery === "unavailable"
			? signInLinkCopy.emailUnavailable(email.reason)
			: null;
	function request(target: SignInLinkTarget) {
		if (!window.confirm(signInLinkCopy.confirm(target.email))) return;
		send.reset();
		send.mutate(target);
	}
	return { send, request, unavailableReason };
}
