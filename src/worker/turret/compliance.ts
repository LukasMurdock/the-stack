import {
	turretComplianceSchema,
	type TurretCompliance,
} from "../../contracts/turret-policy";

type KVNamespaceRead = {
	get(key: string, type: "json"): Promise<unknown>;
};

type KVNamespaceWrite = KVNamespaceRead & {
	put(key: string, value: string): Promise<void>;
};

const COMPLIANCE_KEY = "cfg:compliance:active";

function normalizeTurretCompliance(input: unknown): TurretCompliance {
	const parsed = turretComplianceSchema.safeParse(input);
	if (parsed.success) return parsed.data;
	return turretComplianceSchema.parse({});
}

async function readTurretCompliance(env: {
	TURRET_CFG: KVNamespaceRead;
}): Promise<TurretCompliance> {
	const raw = await env.TURRET_CFG.get(COMPLIANCE_KEY, "json");
	return normalizeTurretCompliance(raw);
}

async function writeTurretCompliance(
	env: { TURRET_CFG: KVNamespaceWrite },
	next: TurretCompliance
): Promise<void> {
	await env.TURRET_CFG.put(COMPLIANCE_KEY, JSON.stringify(next));
}

export {
	COMPLIANCE_KEY,
	normalizeTurretCompliance,
	readTurretCompliance,
	writeTurretCompliance,
};
