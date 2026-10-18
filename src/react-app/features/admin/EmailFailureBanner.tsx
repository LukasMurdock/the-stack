import { useQuery } from "@tanstack/react-query";
import { apiClient, jsonOrThrow } from "../../api";
import type { EmailSendOutcome } from "../../../contracts/email-send-outcome";

const TYPE_LABELS = {
	"reset-password": "password reset",
	"sign-in-link": "sign-in link",
	"verify-email": "email verification",
	generic: "",
} as const satisfies Record<EmailSendOutcome["type"], string>;

const PROVIDER_FIXES = {
	cloudflare:
		"EMAIL_FROM must be a mailbox on a domain onboarded for Cloudflare Email Sending (pnpm exec void email status --platform cloudflare).",
	resend: "EMAIL_FROM must be a mailbox on a domain verified with Resend, and RESEND_API_KEY must be valid.",
} as const;

// Shown on every admin page while the last real provider send failed, so the
// owner learns email is broken before someone is locked out. It clears on the
// next accepted send.
export function EmailFailureBanner() {
	const delivery = useQuery({
		queryKey: ["admin", "email-delivery"],
		retry: false,
		queryFn: async () =>
			jsonOrThrow(await apiClient.internal["email-delivery"].$get()),
	});
	const lastSend = delivery.data?.lastSend;
	if (!lastSend || lastSend.outcome !== "failed") return null;
	const label = TYPE_LABELS[lastSend.type];
	const detail = [lastSend.message, lastSend.code && `(${lastSend.code})`]
		.filter(Boolean)
		.join(" ");
	return (
		<div
			role="alert"
			className="mb-6 space-y-1 rounded-md border border-destructive p-4 text-sm"
		>
			<p className="font-semibold text-destructive">
				Email delivery is failing.
			</p>
			<p>
				The last {label ? `${label} ` : ""}email through{" "}
				{lastSend.provider} failed at{" "}
				{new Date(lastSend.atMs).toLocaleString()}
				{detail ? `: ${detail}` : "."}
			</p>
			<p className="text-muted-foreground">
				Until a send succeeds, these do not reach anyone:{" "}
				{delivery.data?.disabled.join(", ")}. Use Admin → Users → Create
				user to add people meanwhile.
			</p>
			<p className="text-muted-foreground">
				To fix: {PROVIDER_FIXES[lastSend.provider]} Then request a
				password reset to confirm; this notice clears on the next
				accepted send.{" "}
				<a className="underline" href="/docs/v1/auth/#email-delivery">
					Email delivery guide
				</a>
			</p>
		</div>
	);
}
