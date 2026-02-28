import { z } from "zod";

type KVNamespaceRead = {
	get(key: string, type: "json"): Promise<unknown>;
};

type KVNamespaceWrite = KVNamespaceRead & {
	put(key: string, value: string): Promise<void>;
};

const FEATURES_KEY = "cfg:turret:features";

// Keep all Turret feature defaults here.
const TurretFeaturesSchema = z.object({
	storeUserEmail: z.boolean().default(true),
});

type TurretFeatures = z.infer<typeof TurretFeaturesSchema>;

function normalizeTurretFeatures(input: unknown): TurretFeatures {
	const obj =
		input && typeof input === "object"
			? (input as Record<string, unknown>)
			: ({} as Record<string, unknown>);
	const parsed = TurretFeaturesSchema.safeParse(obj);
	if (parsed.success) return parsed.data;
	// If the stored config ever becomes invalid/corrupt, fall back to defaults.
	return TurretFeaturesSchema.parse({});
}

async function readTurretFeatures(env: {
	TURRET_CFG: KVNamespaceRead;
}): Promise<TurretFeatures> {
	const raw = await env.TURRET_CFG.get(FEATURES_KEY, "json");
	return normalizeTurretFeatures(raw);
}

async function writeTurretFeatures(
	env: { TURRET_CFG: KVNamespaceWrite },
	next: TurretFeatures
): Promise<void> {
	await env.TURRET_CFG.put(FEATURES_KEY, JSON.stringify(next));
}

export {
	FEATURES_KEY,
	TurretFeaturesSchema,
	normalizeTurretFeatures,
	readTurretFeatures,
	writeTurretFeatures,
};
export type { TurretFeatures };
