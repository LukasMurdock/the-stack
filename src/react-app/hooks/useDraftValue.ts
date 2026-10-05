import { useState, type SetStateAction } from "react";

// An untouched field follows server data; edits survive background refetches.
// Changing the scope discards the previous record's edits before rendering it.
export function useDraftValue<T>(initialValue: T, scope: string) {
	const [draft, setDraft] = useState<{
		scope: string;
		edit: { value: T } | null;
	}>({ scope, edit: null });
	if (draft.scope !== scope) setDraft({ scope, edit: null });
	const value =
		draft.scope === scope && draft.edit ? draft.edit.value : initialValue;
	function setValue(update: SetStateAction<T>) {
		setDraft((current) => {
			const previous =
				current.scope === scope && current.edit
					? current.edit.value
					: initialValue;
			const next =
				typeof update === "function"
					? (update as (value: T) => T)(previous)
					: update;
			return { scope, edit: { value: next } };
		});
	}
	function reset() {
		setDraft((current) =>
			current.scope === scope ? { scope, edit: null } : current
		);
	}
	return { value, setValue, reset };
}
