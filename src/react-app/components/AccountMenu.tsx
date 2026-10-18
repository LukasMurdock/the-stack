import { useNavigate } from "@tanstack/react-router";
import {
	ChevronDown,
	FileCode,
	LogOut,
	ShieldCheck,
	UserRound,
} from "lucide-react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "../auth";
import { isAdminRole, normalizeAccountRole } from "../../features/auth/policy";

const roleNames = {
	admin: "Administrator",
	user: "Member",
	other: "Custom role",
} as const;

type AccountMenuUser = {
	readonly name?: string | null;
	readonly email: string;
	readonly role?: string | null;
};

// Who is signed in, and everything about the account itself: settings, the
// admin area for administrators, the API reference and signing out. The API
// reference lives here because what it shows depends on the account (admins
// see every operation), and it is a tool for builders, not an app area.
export function AccountMenu({ user }: { user: AccountMenuUser }) {
	const navigate = useNavigate();
	const display = user.name?.trim() || user.email;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Account menu for ${display}`}
				className="flex min-h-11 items-center gap-2 rounded-full py-1 pr-2 pl-1 text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
			>
				<span
					aria-hidden="true"
					className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background"
				>
					{initialsOf(display)}
				</span>
				<span className="hidden max-w-40 truncate sm:inline lg:hidden xl:inline">
					{display}
				</span>
				<ChevronDown
					aria-hidden="true"
					className="size-4 text-muted-foreground"
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="w-64">
				<DropdownMenuGroup>
					<DropdownMenuLabel className="space-y-0.5">
						<span className="block truncate text-sm font-semibold text-foreground">
							{display}
						</span>
						{display !== user.email && (
							<span className="block truncate">{user.email}</span>
						)}
						<span className="block">
							{roleNames[normalizeAccountRole(user.role)]}
						</span>
					</DropdownMenuLabel>
				</DropdownMenuGroup>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onClick={() => void navigate({ to: "/account" })}
				>
					<UserRound />
					Account
				</DropdownMenuItem>
				{isAdminRole(user.role) && (
					<DropdownMenuItem
						onClick={() => void navigate({ to: "/ts_admin" })}
					>
						<ShieldCheck />
						Admin
					</DropdownMenuItem>
				)}
				<DropdownMenuItem
					render={
						<a
							href="/api/scalar"
							target="_blank"
							rel="noreferrer"
						/>
					}
				>
					<FileCode />
					API docs
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onClick={async () => {
						await authClient.signOut();
						await navigate({ to: "/login", search: {} });
					}}
				>
					<LogOut />
					Sign out
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

// Two letters for the avatar: first and last word of a name, or the start of
// an email's local part.
function initialsOf(nameOrEmail: string): string {
	const words = nameOrEmail
		.replace(/@.*/, "")
		.split(/[\s._-]+/)
		.filter(Boolean);
	const first = words[0] ?? "";
	const last = words.length >= 2 ? (words[words.length - 1] ?? "") : "";
	const letters = last
		? `${first[0] ?? ""}${last[0] ?? ""}`
		: first.slice(0, 2);
	return letters.toUpperCase() || "?";
}
