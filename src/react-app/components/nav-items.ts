import { Activity, Building2, House, type LucideIcon } from "lucide-react";

// The one place a fork names the app and lists its areas. The server enforces
// access regardless; this only decides what the header offers.
export const appName = "the-stack";

// Signed-out visitors see "everyone" areas; signed-in people see both. A fork
// with more account roles adds an audience here and a case in offeredTo.
type Audience = "everyone" | "signed-in";

export type NavItem = {
	readonly to: "/" | "/organizations" | "/status";
	readonly label: string;
	readonly icon: LucideIcon;
	readonly audience: Audience;
};

// In display order. Organization-scoped pages (members, the Projects example)
// are tabs inside an organization, not areas here.
const navItems: readonly NavItem[] = [
	{ to: "/", label: "Home", icon: House, audience: "everyone" },
	{
		to: "/organizations",
		label: "Organizations",
		icon: Building2,
		audience: "signed-in",
	},
	{ to: "/status", label: "Status", icon: Activity, audience: "everyone" },
];

// Three tabs fit one row at 320 px; beyond that phones get a bottom bar with
// this many areas, and the rest go under More.
export const TAB_ROW_AREAS_MAX = 3;
export const PHONE_BAR_AREAS_MAX = 4;

function offeredTo(audience: Audience, signedIn: boolean): boolean {
	switch (audience) {
		case "everyone":
			return true;
		case "signed-in":
			return signedIn;
	}
}

export function navItemsFor(signedIn: boolean): readonly NavItem[] {
	return navItems.filter((item) => offeredTo(item.audience, signedIn));
}

export type PhoneBar = {
	readonly bar: readonly NavItem[];
	readonly more: readonly NavItem[];
};

// Null while every area fits the tab row, so phones keep the plain tabs.
export function phoneBarFor(items: readonly NavItem[]): PhoneBar | null {
	if (items.length <= TAB_ROW_AREAS_MAX) return null;
	return {
		bar: items.slice(0, PHONE_BAR_AREAS_MAX),
		more: items.slice(PHONE_BAR_AREAS_MAX),
	};
}

// Home matches only itself; every other area also owns its nested pages.
export function matchesNested(item: NavItem): boolean {
	return item.to !== "/";
}

// Tab links, in the header and in ScrollTabs rows. A ScrollTabs row clips
// overflow, so there the underline sits inside the row, above its border.
export const tabLinkClass =
	"flex min-h-11 shrink-0 items-center border-b-2 border-transparent px-2 whitespace-nowrap text-muted-foreground hover:text-foreground";
export const tabActiveProps = {
	className: "border-foreground! font-semibold text-foreground!",
};
