// Account roles belong to Better Auth; organization roles have their own policy.
export const adminAccountRoles = ["admin"] as const;

// Better Auth stores multiple account roles as a comma-separated string.
// Unknown roles remain visible as "other" rather than being presented as ordinary users.
export function normalizeAccountRole(
	role: unknown
): "admin" | "user" | "other" {
	if (typeof role !== "string") return "user";
	const roles = role
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (
		roles.some((value) =>
			adminAccountRoles.some((admin) => value === admin)
		)
	)
		return "admin";
	if (roles.length === 0 || (roles.length === 1 && roles[0] === "user"))
		return "user";
	return "other";
}

export function isAdminRole(role: unknown): boolean {
	return normalizeAccountRole(role) === "admin";
}
