export type RrwebPlayerInstance = {
	getMetaData?: () => { startTime: number; totalTime?: number };
	goto: (offset: number, play?: boolean) => void;
	$destroy?: () => void;
};

export function jumpReplayToTimestamp(
	player: RrwebPlayerInstance | null,
	timestampMs: number
): void {
	if (!player) return;
	const meta = player.getMetaData?.();
	if (!meta || typeof meta.startTime !== "number") return;
	const totalTime =
		typeof meta.totalTime === "number" ? meta.totalTime : Infinity;
	const offset = Math.max(
		0,
		Math.min(totalTime, timestampMs - meta.startTime)
	);
	player.goto(offset, false);
}
