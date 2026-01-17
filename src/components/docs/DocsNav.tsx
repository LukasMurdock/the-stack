import * as React from "react";

import {
	NavigationMenu,
	NavigationMenuItem,
	NavigationMenuLink,
	NavigationMenuList,
} from "@/components/ui/navigation-menu";

type DocsNavProps = {
	pathname: string;
};

function isActive(pathname: string, href: string) {
	if (href === "/docs/") return pathname === "/docs" || pathname === "/docs/";
	return pathname === href || pathname.startsWith(href);
}

export function DocsNav({ pathname }: DocsNavProps) {
	const linkClass = React.useCallback(
		(href: string) =>
			isActive(pathname, href) ? "bg-accent text-accent-foreground" : undefined,
		[pathname],
	);

	const ariaCurrent = React.useCallback(
		(href: string) => (isActive(pathname, href) ? "page" : undefined),
		[pathname],
	);

	return (
		<NavigationMenu viewport={false} className="flex-1">
			<NavigationMenuList className="gap-1">
				<NavigationMenuItem>
					<NavigationMenuLink
						href="/docs/v1/welcome/"
						className={linkClass("/docs/v1/welcome/")}
						aria-current={ariaCurrent("/docs/v1/welcome/")}
					>
						Getting Started
					</NavigationMenuLink>
				</NavigationMenuItem>

				<NavigationMenuItem>
					<NavigationMenuLink
						href="/docs/"
						className={linkClass("/docs/")}
						aria-current={ariaCurrent("/docs/")}
					>
						All Docs
					</NavigationMenuLink>
				</NavigationMenuItem>

				<NavigationMenuItem>
					<NavigationMenuLink
						href="/api/scalar"
						className={linkClass("/api/scalar")}
						aria-current={ariaCurrent("/api/scalar")}
					>
						API
					</NavigationMenuLink>
				</NavigationMenuItem>
			</NavigationMenuList>
		</NavigationMenu>
	);
}
