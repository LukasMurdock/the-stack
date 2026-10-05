import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

const RESET_MS = 2000;

// Copies `value` and reports the outcome visibly and to screen readers.
// Clipboard writes can reject (permissions, insecure context, unfocused
// document), so failure is surfaced instead of silently ignored.
function CopyButton(props: { value: string; label: string; noun: string }) {
	const [state, setState] = useState<CopyState>("idle");
	const resetTimer = useRef<number | null>(null);

	useEffect(
		() => () => {
			if (resetTimer.current != null)
				window.clearTimeout(resetTimer.current);
		},
		[]
	);

	async function copy() {
		let next: CopyState;
		try {
			if (!navigator.clipboard?.writeText) {
				throw new Error("Clipboard API unavailable");
			}
			await navigator.clipboard.writeText(props.value);
			next = "copied";
		} catch {
			next = "failed";
		}
		setState(next);
		if (resetTimer.current != null) window.clearTimeout(resetTimer.current);
		resetTimer.current = window.setTimeout(
			() => setState("idle"),
			RESET_MS
		);
	}

	return (
		<>
			<Button
				type="button"
				variant={state === "failed" ? "destructive" : "outline"}
				size="xs"
				onClick={() => void copy()}
			>
				{state === "copied"
					? "Copied"
					: state === "failed"
						? "Copy failed"
						: props.label}
			</Button>
			<span role="status" className="sr-only">
				{state === "copied"
					? `${props.noun} copied`
					: state === "failed"
						? `Couldn't copy ${props.noun}. Select the text to copy it manually.`
						: ""}
			</span>
		</>
	);
}

export { CopyButton };
