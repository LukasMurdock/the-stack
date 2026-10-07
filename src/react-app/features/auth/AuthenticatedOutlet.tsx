import { Outlet } from "@tanstack/react-router";
import { authClient } from "../../auth";

// The route validated this identity. Hide its private subtree while the session
// changes, and remount it when a replacement identity has been validated.
export function AuthenticatedOutlet({ userId }: { userId: string }) {
	const session = authClient.useSession();
	const matches = !session.isPending && session.data?.user.id === userId;
	return matches ? <Outlet key={userId} /> : <p>Checking session…</p>;
}
