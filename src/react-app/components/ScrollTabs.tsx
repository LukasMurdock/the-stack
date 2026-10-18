import * as React from "react";
import { useRouterState } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

// A tab row that scrolls sideways on narrow screens. Edges fade only where
// more tabs are hidden, so it is clear the row continues, and the current tab
// is scrolled into view on every navigation.
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
	const pathname = useRouterState({
		select: (state) => state.location.pathname,
	});
	const [hidden, setHidden] = React.useState({ start: false, end: false });

	const measure = React.useCallback(() => {
		const row = ref.current;
		if (!row) return;
		const endGapPx = row.scrollWidth - row.clientWidth - row.scrollLeft;
		setHidden({ start: row.scrollLeft > 1, end: endGapPx > 1 });
	}, []);

	React.useLayoutEffect(() => {
		const row = ref.current;
		if (!row) return;
		const current = row.querySelector<HTMLElement>('[aria-current="page"]');
		current?.scrollIntoView({ block: "nearest", inline: "nearest" });
		measure();
	}, [pathname, measure]);

	React.useEffect(() => {
		const row = ref.current;
		if (!row) return;
		const observer = new ResizeObserver(measure);
		observer.observe(row);
		return () => observer.disconnect();
	}, [measure]);

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
