import { z } from "zod";

type KVNamespaceRead = {
	get(key: string, type: "json"): Promise<unknown>;
};

type KVNamespaceWrite = KVNamespaceRead & {
	put(key: string, value: string): Promise<void>;
};

const UPTIME_STATUS_KEY = "uptime:status:v1";

const TurretUptimeServiceSchema = z.object({
	id: z.string(),
	name: z.string(),
	status: z.enum(["up", "down", "unknown"]).default("unknown"),
	checkedAtMs: z.number().default(0),
	latencyMs: z.number().nullable().default(null),
	httpStatus: z.number().nullable().default(null),
	message: z.string().nullable().default(null),
});

const TurretUptimeStatusSchema = z.object({
	version: z.literal(1),
	updatedAtMs: z.number().default(0),
	overall: z.enum(["up", "degraded", "down", "unknown"]).default("unknown"),
	services: z.array(TurretUptimeServiceSchema).default([]),
});

type TurretUptimeStatus = z.infer<typeof TurretUptimeStatusSchema>;

function normalizeTurretUptimeStatus(input: unknown): TurretUptimeStatus {
	const obj =
		input && typeof input === "object" ? (input as Record<string, unknown>) : ({} as Record<string, unknown>);
	const parsed = TurretUptimeStatusSchema.safeParse(obj);
	if (parsed.success) return parsed.data;
	return TurretUptimeStatusSchema.parse({ version: 1 });
}

async function readTurretUptimeStatus(env: { TURRET_UPTIME: KVNamespaceRead }): Promise<TurretUptimeStatus> {
	const raw = await env.TURRET_UPTIME.get(UPTIME_STATUS_KEY, "json");
	return normalizeTurretUptimeStatus(raw);
}

async function writeTurretUptimeStatus(env: { TURRET_UPTIME: KVNamespaceWrite }, next: TurretUptimeStatus): Promise<void> {
	await env.TURRET_UPTIME.put(UPTIME_STATUS_KEY, JSON.stringify(next));
}

export {
	UPTIME_STATUS_KEY,
	TurretUptimeServiceSchema,
	TurretUptimeStatusSchema,
	normalizeTurretUptimeStatus,
	readTurretUptimeStatus,
	writeTurretUptimeStatus,
};

export type { TurretUptimeStatus };
