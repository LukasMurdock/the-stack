import { useId, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { uiCopy } from "./copy";
import type { UnitState } from "./unitState";

// Skeleton rows shown while a Unit loads.
const LOADING_ROWS = 3;

// A screen section: a header (title, one-line meta, at most one action) and
// one body. It owns the loading, empty and error states and their copy, so
// every section behaves the same. `surface` draws a card, only for a section
// that acts as one object (a form, a summary).
export function Unit({
	title,
	meta,
	action,
	surface = false,
	tabPanel = false,
	state = { kind: "ready" },
	children,
}: {
	title: string;
	meta?: ReactNode;
	action?: ReactNode;
	surface?: boolean;
	// The only Unit in a tab: the tab already names it, so its title is for
	// screen readers only. A tab with several Units shows each title.
	tabPanel?: boolean;
	state?: UnitState;
	children?: ReactNode;
}) {
	const id = useId();
	return (
		<section
			aria-labelledby={id}
			aria-busy={state.kind === "loading" || undefined}
			className={cn(
				"space-y-3",
				surface && "rounded-2xl border bg-card p-4 sm:p-5"
			)}
		>
			{tabPanel && !meta && !action ? (
				// Nothing else in the header: just the heading, out of the flow.
				<h2 id={id} className="sr-only">
					{title}
				</h2>
			) : (
				<header className="flex items-start justify-between gap-3">
					<div className="min-w-0 space-y-0.5">
						<h2
							id={id}
							className={cn(
								"text-lg font-semibold tracking-tight",
								tabPanel && "sr-only"
							)}
						>
							{title}
						</h2>
						{meta && (
							<p className="text-sm text-muted-foreground">
								{meta}
							</p>
						)}
					</div>
					{action && <div className="shrink-0">{action}</div>}
				</header>
			)}
			<UnitBody title={title} state={state}>
				{children}
			</UnitBody>
		</section>
	);
}

function UnitBody({
	title,
	state,
	children,
}: {
	title: string;
	state: UnitState;
	children: ReactNode;
}) {
	switch (state.kind) {
		case "loading":
			return (
				<div className="space-y-2">
					{Array.from({ length: LOADING_ROWS }, (_, index) => (
						<Skeleton
							key={index}
							className="h-14 w-full rounded-xl"
						/>
					))}
				</div>
			);
		case "error":
			return (
				<div role="alert" className="space-y-2">
					<p className="font-medium">{uiCopy.loadFailed(title)}</p>
					<Button variant="outline" onClick={state.retry}>
						{uiCopy.retry}
					</Button>
				</div>
			);
		case "empty":
			return <p className="text-muted-foreground">{state.title}</p>;
		case "ready":
			return children;
	}
}

// Rows in a Unit, inside `<ul className="-mx-3">` so their padding lines up
// with the title. An actionable row is one target at least 44px tall.
export const unitRowStaticClass =
	"flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left";
export const unitRowClass = `${unitRowStaticClass} transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none active:bg-muted`;
