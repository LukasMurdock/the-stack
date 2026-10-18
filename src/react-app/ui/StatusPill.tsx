import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { toneClasses, type Tone } from "./tone";

// A state as a chip. The label always carries the meaning; color only
// reinforces it.
export function StatusPill({
	tone,
	children,
}: {
	tone: Tone;
	children: ReactNode;
}) {
	return (
		<span
			className={cn(
				"inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium whitespace-nowrap",
				toneClasses.pill[tone]
			)}
		>
			<span aria-hidden className="size-1.5 rounded-full bg-current" />
			{children}
		</span>
	);
}
