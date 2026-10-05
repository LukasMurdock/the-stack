export type RangePreset = "15m" | "1h" | "24h" | "custom";
export type GroupBy = "none" | "user";

export function parseReplaySearch(s: Record<string, unknown>) {
	const legacyGrouped =
		s.grouped === true || s.grouped === "true" || s.grouped === "1";
	const preset: RangePreset =
		s.preset === "15m" ||
		s.preset === "1h" ||
		s.preset === "24h" ||
		s.preset === "custom"
			? s.preset
			: "1h";
	const groupBy: GroupBy =
		s.groupBy === "none" || s.groupBy === "user"
			? s.groupBy
			: legacyGrouped
				? "user"
				: "none";
	return {
		q: typeof s.q === "string" ? s.q : "",
		hasError: s.hasError === "1" || s.hasError === true,
		groupBy,
		preset,
		from:
			typeof s.from === "number"
				? s.from
				: typeof s.from === "string"
					? Number(s.from)
					: undefined,
		to:
			typeof s.to === "number"
				? s.to
				: typeof s.to === "string"
					? Number(s.to)
					: undefined,
		offset:
			typeof s.offset === "number"
				? s.offset
				: typeof s.offset === "string"
					? Number(s.offset)
					: 0,
		limit:
			typeof s.limit === "number"
				? s.limit
				: typeof s.limit === "string"
					? Number(s.limit)
					: 50,
	};
}
