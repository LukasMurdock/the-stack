export type OverflowItem =
	| {
			label: string;
			onSelect: () => void;
			destructive?: boolean;
			disabled?: boolean;
	  }
	| "separator";

// Separators only between actions: none leading, trailing or doubled, so a
// caller can build the list from conditional parts.
export function visibleItems(items: readonly OverflowItem[]): OverflowItem[] {
	const shown: OverflowItem[] = [];
	for (const item of items) {
		if (
			item === "separator" &&
			(shown.at(-1) ?? "separator") === "separator"
		)
			continue;
		shown.push(item);
	}
	if (shown.at(-1) === "separator") shown.pop();
	return shown;
}
