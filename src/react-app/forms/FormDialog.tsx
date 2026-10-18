import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";

// A button whose form opens in a dialog: a screen's one primary action, such
// as "New organization". The form receives `close` to call after a successful
// save; closing also tells the caller, so it can clear stale mutation errors.
export function FormDialog({
	triggerLabel,
	title,
	onClosed,
	children,
}: {
	triggerLabel: string;
	title: string;
	onClosed?: () => void;
	children: (close: () => void) => ReactNode;
}) {
	const [open, setOpen] = useState(false);
	const change = (next: boolean) => {
		setOpen(next);
		if (!next) onClosed?.();
	};
	return (
		<Dialog open={open} onOpenChange={change}>
			<DialogTrigger render={<Button />}>{triggerLabel}</DialogTrigger>
			<DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
				</DialogHeader>
				{children(() => change(false))}
			</DialogContent>
		</Dialog>
	);
}
