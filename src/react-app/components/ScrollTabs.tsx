import * as React from "react";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

// A tab row that scrolls sideways on narrow screens. Edges fade only where
// more tabs are hidden, so it is clear the row continues, and the current tab
// is scrolled into view on every navigation and whenever a tab resizes (a
// count loading in can push it past the edge).
export function ScrollTabs({
	label,
	className,
	children,
}: {
	label: string;
	className?: string;
	children: React.ReactNode;
}) {
	const ref = React.useRef<HTMLElement>(null);
	// Search too: a page may keep its open tab in the query string.
	const href = useRouterState({ select: (state) => state.location.href });
	const [hidden, setHidden] = React.useState({ start: false, end: false });

	const measure = React.useCallback(() => {
		const row = ref.current;
		if (!row) return;
		const endGapPx = row.scrollWidth - row.clientWidth - row.scrollLeft;
		setHidden({ start: row.scrollLeft > 1, end: endGapPx > 1 });
	}, []);

	const reveal = React.useCallback(() => {
		const row = ref.current;
		if (!row) return;
		revealCurrent(row);
		measure();
	}, [measure]);

	React.useLayoutEffect(reveal, [href, reveal]);

	React.useEffect(() => {
		const row = ref.current;
		if (!row) return;
		const observer = new ResizeObserver(reveal);
		observer.observe(row);
		for (const tab of row.children) observer.observe(tab);
		return () => observer.disconnect();
	}, [reveal]);

	const fade = "transparent, black 2.5rem";
	return (
		<nav
			ref={ref}
			aria-label={label}
			onScroll={measure}
			className={cn(
				"flex gap-1 overflow-x-auto [scrollbar-width:none]",
				className
			)}
			style={maskStyle(
				hidden.start ? `linear-gradient(to right, ${fade})` : null,
				hidden.end ? `linear-gradient(to left, ${fade})` : null
			)}
		>
			{children}
		</nav>
	);
}

// Scrolls the row, never the page, just enough to show the current tab.
function revealCurrent(row: HTMLElement) {
	const current = row.querySelector<HTMLElement>('[aria-current="page"]');
	if (!current) return;
	const box = row.getBoundingClientRect();
	const tab = current.getBoundingClientRect();
	if (tab.left < box.left) row.scrollLeft -= box.left - tab.left;
	else if (tab.right > box.right) row.scrollLeft += tab.right - box.right;
}

// Both edges: intersect the two gradients so each fades independently.
function maskStyle(
	start: string | null,
	end: string | null
): React.CSSProperties | undefined {
	const layers = [start, end].filter((layer) => layer !== null);
	if (layers.length === 0) return undefined;
	const image = layers.join(", ");
	return {
		maskImage: image,
		WebkitMaskImage: image,
		maskComposite: "intersect",
		WebkitMaskComposite: "source-in",
	};
}
