// The words of each auth email: its heading (also the subject, with the
// product name), body, button and footer.
export type AuthEmailType = "verify-email" | "reset-password" | "sign-in-link";

type AuthEmailCopy = {
	readonly heading: string;
	readonly body: string;
	readonly action: string;
	readonly footer: string;
};

const IGNORE_FOOTER =
	"If you did not request this email, you can safely ignore it.";

export function authEmailCopy(
	type: AuthEmailType,
	productName: string
): AuthEmailCopy {
	if (type === "reset-password")
		return {
			heading: "Reset your password",
			body: `We received a request to reset the password for your ${productName} account. Use the button below to choose a new password.`,
			action: "Reset password",
			footer: IGNORE_FOOTER,
		};
	if (type === "sign-in-link")
		return {
			heading: "Set your password",
			body: `Your ${productName} account is ready. Use the button below to choose a password, then sign in with your email address and that password.`,
			action: "Set password",
			footer: "The link works once and expires in one hour. If it has expired, ask the person who set up your account for a new one.",
		};
	return {
		heading: "Verify your email",
		body: `Thanks for signing up for ${productName}. Please confirm your email address by clicking the button below.`,
		action: "Verify email",
		footer: IGNORE_FOOTER,
	};
}
