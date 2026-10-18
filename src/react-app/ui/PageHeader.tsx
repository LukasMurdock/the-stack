import type { ReactNode } from "react";

// A top-level page's title (its only h1), an optional one-line meta, and at
// most one primary action, such as "New organization".
export function PageHeader({
	title,
	meta,
	action,
}: {
	title: string;
	meta?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<header className="flex items-start justify-between gap-3">
			<div className="min-w-0 space-y-0.5">
				<h1 className="text-2xl font-semibold tracking-tight">
					{title}
				</h1>
				{meta && (
					<p className="text-sm text-muted-foreground">{meta}</p>
				)}
			</div>
			{action && <div className="shrink-0">{action}</div>}
		</header>
	);
}
