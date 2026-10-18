import {
	Link,
	Outlet,
	useMatchRoute,
	useNavigate,
} from "@tanstack/react-router";
import { Ellipsis } from "lucide-react";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TurretFeedbackWidget } from "../features/turret/FeedbackWidget";
import { authClient } from "../auth";
import { AccountMenu } from "./AccountMenu";
import {
	appName,
	matchesNested,
	navItemsFor,
	phoneBarFor,
	tabActiveProps,
	tabLinkClass,
	type NavItem,
	type PhoneBar,
} from "./nav-items";

// One row from laptop width: brand, the areas as tabs, account. Narrower, the
// tabs wrap to a second row; phones with more areas than fit a row get a
// bottom bar instead, so no area is ever cut off the edge of the screen.
export function AppLayout({ children }: { children?: React.ReactNode }) {
	const session = authClient.useSession();
	const user = session.data?.user;
	const items = navItemsFor(Boolean(user));
	const phoneBar = phoneBarFor(items);
	return (
		<div>
			<header className="border-b">
				<div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-2 px-4 py-2 lg:flex-nowrap lg:py-0">
					<Link
						to="/"
						className="order-1 mr-auto flex min-h-11 items-center text-lg font-semibold tracking-tight whitespace-nowrap lg:mr-4"
					>
						{appName}
					</Link>
					{/* One area needs no tabs: the page title says where you are. */}
					{items.length > 1 && (
						<Tabs
							items={items}
							hiddenOnPhones={phoneBar !== null}
						/>
					)}
					{/* Forks with search put its button here, before the account. */}
					<div className="order-4 flex min-h-11 items-center">
						{user ? (
							<AccountMenu user={user} />
						) : session.isPending ? null : (
							<Link
								to="/login"
								search={{}}
								className="flex min-h-11 items-center px-2 text-sm"
							>
								Sign in
							</Link>
						)}
					</div>
				</div>
			</header>

			<main
				className={cn(
					"mx-auto max-w-5xl px-4 py-6",
					phoneBar && "pb-28 md:pb-6"
				)}
			>
				{children ?? <Outlet />}
			</main>
			{phoneBar && <PhoneBarNav phoneBar={phoneBar} />}
			<TurretFeedbackWidget />
		</div>
	);
}

// From laptop width the underline sits on the header's bottom border.
const headerTabClass = cn(tabLinkClass, "-mb-px lg:min-h-14");

// Inline from laptop width; below it a second row flush with the header's
// bottom edge. With a phone bar it is hidden on phones.
function Tabs({
	items,
	hiddenOnPhones,
}: {
	items: readonly NavItem[];
	hiddenOnPhones: boolean;
}) {
	return (
		<nav
			aria-label="Main"
			className={cn(
				"order-last -mx-2 -mb-2 basis-full items-center gap-1 text-sm lg:order-2 lg:mx-0 lg:mr-auto lg:mb-0 lg:basis-auto",
				hiddenOnPhones ? "hidden md:flex" : "flex"
			)}
		>
			{items.map((item) => (
				<Link
					key={item.to}
					to={item.to}
					activeOptions={{ exact: !matchesNested(item) }}
					className={headerTabClass}
					activeProps={tabActiveProps}
				>
					{item.label}
				</Link>
			))}
		</nav>
	);
}

const barItemClass =
	"flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] text-muted-foreground";

// Phones: the first areas within thumb reach, the rest under More. The
// data-tab-bar attribute sets --bottom-bar so the feedback button sits above.
function PhoneBarNav({ phoneBar }: { phoneBar: PhoneBar }) {
	return (
		<nav
			aria-label="Main"
			data-tab-bar
			className="fixed inset-x-0 bottom-0 z-40 flex border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
		>
			{phoneBar.bar.map((item) => (
				<Link
					key={item.to}
					to={item.to}
					activeOptions={{ exact: !matchesNested(item) }}
					className={barItemClass}
					activeProps={{
						className: "font-semibold text-foreground!",
					}}
				>
					<item.icon className="size-5" aria-hidden="true" />
					{item.label}
				</Link>
			))}
			{phoneBar.more.length > 0 && <MoreMenu items={phoneBar.more} />}
		</nav>
	);
}

// Names the current area when it is one of these, so the bar always shows
// where you are.
function MoreMenu({ items }: { items: readonly NavItem[] }) {
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const current = items.find((item) =>
		Boolean(matchRoute({ to: item.to, fuzzy: matchesNested(item) }))
	);
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				className={cn(
					barItemClass,
					"outline-none",
					current && "font-semibold text-foreground"
				)}
			>
				{current ? (
					<current.icon className="size-5" aria-hidden="true" />
				) : (
					<Ellipsis className="size-5" aria-hidden="true" />
				)}
				{current?.label ?? "More"}
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="end" className="w-52">
				{items.map((item) => (
					<DropdownMenuItem
						key={item.to}
						onClick={() => void navigate({ to: item.to })}
						className={cn(item === current && "font-semibold")}
					>
						<item.icon />
						{item.label}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
