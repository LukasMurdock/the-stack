import { MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { uiCopy } from "./copy";
import { visibleItems, type OverflowItem } from "./overflowItems";

// The ⋯ menu: secondary and rare actions, so the screen keeps one primary.
// Renders nothing when no action remains.
export function OverflowMenu({
	items,
	label = uiCopy.more,
}: {
	items: readonly OverflowItem[];
	label?: string;
}) {
	const shown = visibleItems(items);
	if (shown.length === 0) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<Button variant="ghost" size="icon-lg" aria-label={label} />
				}
			>
				<MoreHorizontal />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{shown.map((item, index) =>
					item === "separator" ? (
						<DropdownMenuSeparator key={`separator-${index}`} />
					) : (
						<DropdownMenuItem
							key={item.label}
							variant={
								item.destructive ? "destructive" : "default"
							}
							disabled={item.disabled}
							onClick={item.onSelect}
						>
							{item.label}
						</DropdownMenuItem>
					)
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
