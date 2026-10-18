import type { ReactNode } from "react";

// Classes for the "← All organizations" link above a record; pass a router Link.
export const backLinkClass =
	"-ml-1 inline-flex min-h-11 items-center gap-1 rounded-lg px-1 text-sm text-muted-foreground hover:text-foreground";

// What a record is: a back link, its title (the page's only h1) and one line
// of key facts. Its tabs and sections follow beneath.
export function RecordHeader({
	back,
	title,
	facts,
}: {
	back: ReactNode;
	title: string;
	facts?: ReactNode;
}) {
	return (
		<header className="space-y-1">
			{back}
			<h1 className="text-2xl font-semibold tracking-tight break-words">
				{title}
			</h1>
			{facts && <p className="text-sm text-muted-foreground">{facts}</p>}
		</header>
	);
}
