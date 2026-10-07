import {
	turretFeaturesSchema,
	type TurretFeatures,
} from "../../contracts/turret-features";

type KVNamespaceRead = {
	get(key: string, type: "json"): Promise<unknown>;
};

type KVNamespaceWrite = KVNamespaceRead & {
	put(key: string, value: string): Promise<void>;
};

const FEATURES_KEY = "cfg:turret:features";

function normalizeTurretFeatures(input: unknown): TurretFeatures {
	const parsed = turretFeaturesSchema.safeParse(input);
	if (parsed.success) return parsed.data;
	// If the stored config ever becomes invalid/corrupt, fall back to defaults.
	return turretFeaturesSchema.parse({});
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
	normalizeTurretFeatures,
	readTurretFeatures,
	writeTurretFeatures,
};
