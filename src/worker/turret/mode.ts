type TurretMode = "off" | "basic" | "full";

type TurretModeStatus = {
	configuredMode: TurretMode;
	effectiveMode: TurretMode;
	ingestEnabled: boolean;
	reason: string | null;
};

function resolveTurretMode(raw: string | undefined): TurretMode {
	const normalized = raw?.trim().toLowerCase();
	if (normalized === "off") return "off";
	if (normalized === "basic") return "basic";
	if (normalized === "full") return "full";
	return "full";
}

function resolveTurretModeStatus(input: {
	modeRaw?: string;
	hasSigningKey: boolean;
}): TurretModeStatus {
	const configuredMode = resolveTurretMode(input.modeRaw);
	if (configuredMode === "off") {
		return {
			configuredMode,
			effectiveMode: "off",
			ingestEnabled: false,
			reason: "turret_off",
		};
	}

	if (configuredMode === "basic") {
		return {
			configuredMode,
			effectiveMode: "basic",
			ingestEnabled: false,
			reason: "turret_basic_no_ingest",
		};
	}

	if (input.hasSigningKey) {
		return {
			configuredMode,
			effectiveMode: "full",
			ingestEnabled: true,
			reason: null,
		};
	}

	return {
		configuredMode,
		effectiveMode: "basic",
		ingestEnabled: false,
		reason: "missing_turret_signing_key",
	};
}

export { resolveTurretMode, resolveTurretModeStatus };
export type { TurretMode, TurretModeStatus };
