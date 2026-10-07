import { z } from "zod";
import {
	turretTimeRangeSchema,
	turretRangeDurations,
	resolveTurretTimeRange,
} from "../../../contracts/turret-time-range";
// Search holds an editable range; the HTTP contract validates its ordering on submission.
export const timeRangeSearchSchema = z.object(turretTimeRangeSchema.shape);
export function presetToRange(
	preset: keyof typeof turretRangeDurations | "custom",
	now: number
): { from?: number; to?: number } {
	return preset === "custom"
		? {}
		: resolveTurretTimeRange({}, now, turretRangeDurations[preset]);
}
export function toLocalDatetimeValue(ms?: number): string {
	if (ms === undefined) return "";
	const d = new Date(ms);
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalDatetimeValue(value: string): number | undefined {
	if (!value) return undefined;
	const ms = new Date(value).getTime();
	return Number.isFinite(ms) ? ms : undefined;
}
