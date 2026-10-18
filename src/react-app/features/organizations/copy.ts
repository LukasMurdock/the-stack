import type { Organization } from "@/contracts/organizations";
import { formatDate, plural } from "../../ui/format";

// Every organization string: the list, an organization's header, members and
// invitations. Screens pick from here instead of writing their own.

type MemberRole = Organization["role"];

export const roleLabels = {
	owner: "Owner",
	editor: "Editor",
	viewer: "Viewer",
} satisfies Record<MemberRole, string>;

export const organizationCopy = {
	organizations: "Organizations",
	yours: "Your organizations",
	organizationCount: (count: number) => plural(count, "organization"),
	newOrganization: "New organization",
	name: "Organization name",
	create: "Create organization",
	creating: "Creating…",
	noOrganizations: "No organizations yet",
	allOrganizations: "All organizations",
	tabs: "Organization",
	// "Owner access": what you may do here, under the organization's name.
	yourAccess: (role: MemberRole) => `${roleLabels[role]} access`,

	members: "Members",
	memberCount: (count: number) => plural(count, "member"),
	noMembers: "No members on this page",
	actionsFor: (name: string) => `Actions for ${name}`,
	makeRole: (role: MemberRole) => `Make ${roleLabels[role].toLowerCase()}`,
	remove: "Remove",
	confirmRemove: (name: string) => `Remove ${name}?`,

	invite: "Invite a member",
	inviteMeta: "They sign in or create an account with this email to join.",
	emailAddress: "Email address",
	access: "Access",
	createInvitation: "Create invitation",
	invitationLink: "Invitation link",
	pendingInvitations: "Pending invitations",
	noInvitations: "No pending invitations",
	revoke: "Revoke",
	expires: (expiresAtMs: number) => `Expires ${formatDate(expiresAtMs)}`,
};
