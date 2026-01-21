import { z } from "zod";

type KVNamespaceRead = {
	get(key: string, type: "json"): Promise<unknown>;
};

type KVNamespaceWrite = KVNamespaceRead & {
	put(key: string, value: string): Promise<void>;
};

const COMPLIANCE_KEY = "cfg:compliance:active";

// Keep the default policy here so both session init + settings page stay in sync.
const TurretComplianceSchema = z.object({
	version: z.string().default("v1"),
	retentionDays: z.number().int().min(1).max(365).default(14),
	rrweb: z
		.object({
			maskAllInputs: z.boolean().default(true),
		})
		.passthrough()
		.default({ maskAllInputs: true }),
	console: z
		.object({
			enabled: z.boolean().default(true),
			level: z.array(z.enum(["log", "info", "warn", "error"])).default(["log", "info", "warn", "error"]),
			lengthThreshold: z.number().int().min(0).max(10_000).default(200),
			stringifyOptions: z
				.object({
					stringLengthLimit: z.number().int().min(0).max(100_000).optional(),
					numOfKeysLimit: z.number().int().min(1).max(1_000).default(30),
					depthOfLimit: z.number().int().min(1).max(20).default(2),
				})
				.default({ stringLengthLimit: 300, numOfKeysLimit: 30, depthOfLimit: 2 }),
		})
		.passthrough()
		.default({
			enabled: true,
			level: ["log", "info", "warn", "error"],
			lengthThreshold: 200,
			stringifyOptions: { stringLengthLimit: 300, numOfKeysLimit: 30, depthOfLimit: 2 },
		}),
});

type TurretCompliance = z.infer<typeof TurretComplianceSchema>;

function normalizeTurretCompliance(input: unknown): TurretCompliance {
	const obj =
		input && typeof input === "object"
			? (input as Record<string, unknown>)
			: ({} as Record<string, unknown>);
	const parsed = TurretComplianceSchema.safeParse(obj);
	if (parsed.success) return parsed.data;
	return TurretComplianceSchema.parse({});
}

async function readTurretCompliance(env: { TURRET_CFG: KVNamespaceRead }): Promise<TurretCompliance> {
	const raw = await env.TURRET_CFG.get(COMPLIANCE_KEY, "json");
	return normalizeTurretCompliance(raw);
}

async function writeTurretCompliance(env: { TURRET_CFG: KVNamespaceWrite }, next: TurretCompliance): Promise<void> {
	await env.TURRET_CFG.put(COMPLIANCE_KEY, JSON.stringify(next));
}

export {
	COMPLIANCE_KEY,
	TurretComplianceSchema,
	normalizeTurretCompliance,
	readTurretCompliance,
	writeTurretCompliance,
};

export type { TurretCompliance };
