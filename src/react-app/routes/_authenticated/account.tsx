import { createFileRoute } from "@tanstack/react-router";
import { AccountPage } from "../../features/auth/AccountPage";

export const Route = createFileRoute("/_authenticated/account")({
	component: AccountPage,
});
