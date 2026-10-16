// Whether a deployment can send auth email, judged from configuration alone.
// The Worker reports it from /api/readiness and `pnpm doctor` from the
// deployment config, so an owner learns that invitations and password resets
// are dead before trying them. Dependency-free: Node scripts import it too.

export const LOCAL_APP_ENVS = ["local", "dev", "development", "test"] as const;

// What stops working without a provider, in the words the owner would use.
export const EMAIL_DEPENDENT_FEATURES = [
	"invitations",
	"password reset",
	"email verification",
] as const;

// RFC 2606 / 6761 reserved names: the template's placeholders use them, and
// no provider delivers mail from them.
const RESERVED_TOP_LEVEL_DOMAINS = ["example", "test", "invalid", "localhost"];
const RESERVED_SECOND_LEVEL_DOMAINS = [
	"example.com",
	"example.net",
	"example.org",
];

export type Presence = "present" | "absent";

export type EmailDeliveryInput = {
	readonly appEnv: string | undefined;
	readonly transport: string | undefined;
	readonly sender: string | undefined;
	readonly sendEmailBinding: Presence;
	readonly resendApiKey: Presence;
};

export type EmailDelivery =
	| {
			readonly delivery: "provider";
			readonly transport: "cloudflare" | "resend";
	  }
	| { readonly delivery: "log_only" }
	| { readonly delivery: "unavailable"; readonly reason: string };

export function isLocalAppEnv(appEnv: string | undefined): boolean {
	return LOCAL_APP_ENVS.some((local) => local === appEnv);
}

// Mirrors resolveEmailTransport/sendEmail's checks without throwing. A
// configured Cloudflare binding still needs the sender domain onboarded,
// which only `void email status --platform cloudflare` can confirm.
export function describeEmailDelivery(
	input: EmailDeliveryInput
): EmailDelivery {
	const local = isLocalAppEnv(input.appEnv);
	const transport = input.transport ?? (local ? "log" : "cloudflare");
	if (transport === "log") {
		if (local) return { delivery: "log_only" };
		return unavailable("EMAIL_TRANSPORT=log only works in local/dev/test.");
	}
	if (transport !== "cloudflare" && transport !== "resend")
		return unavailable(
			"EMAIL_TRANSPORT must be cloudflare, resend, or log."
		);
	if (!local) {
		const domain = senderDomain(input.sender);
		if (domain === undefined)
			return unavailable("EMAIL_FROM is not a sender mailbox.");
		if (isReservedDomain(domain))
			return unavailable(
				`EMAIL_FROM uses the placeholder domain ${domain}.`
			);
	}
	if (transport === "cloudflare") {
		if (input.sendEmailBinding === "absent")
			return unavailable("The SEND_EMAIL binding is missing.");
		return { delivery: "provider", transport };
	}
	if (input.resendApiKey === "absent")
		return unavailable("EMAIL_TRANSPORT=resend needs RESEND_API_KEY.");
	return { delivery: "provider", transport };
}

function unavailable(reason: string): EmailDelivery {
	return { delivery: "unavailable", reason };
}

// Accepts `name@domain` and `Name <name@domain>`, the two forms sendEmail
// accepts. Returns the lower-cased domain.
function senderDomain(sender: string | undefined): string | undefined {
	if (sender === undefined) return undefined;
	const display = sender.trim().match(/<([^<>]+)>$/);
	const mailbox = (display?.[1] ?? sender).trim();
	const at = mailbox.lastIndexOf("@");
	if (at < 1) return undefined;
	const domain = mailbox.slice(at + 1).toLowerCase();
	if (domain.length === 0) return undefined;
	return domain;
}

function isReservedDomain(domain: string): boolean {
	const labels = domain.split(".");
	const topLevel = labels.at(-1);
	if (topLevel !== undefined && RESERVED_TOP_LEVEL_DOMAINS.includes(topLevel))
		return true;
	return RESERVED_SECOND_LEVEL_DOMAINS.some(
		(reserved) => domain === reserved || domain.endsWith(`.${reserved}`)
	);
}
