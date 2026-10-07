import { z } from "zod";

const consoleLevelSchema = z.enum(["log", "info", "warn", "error"]);
// Validators have no defaults, so omitted patch fields can never acquire stored values.
const rrwebValuesSchema = z.object({ maskAllInputs: z.boolean() });
const stringifyValuesSchema = z.object({
	stringLengthLimit: z.number().int().min(0).max(100_000).optional(),
	numOfKeysLimit: z.number().int().min(1).max(1_000),
	depthOfLimit: z.number().int().min(1).max(20),
});
const consoleValuesSchema = z.object({
	enabled: z.boolean(),
	level: z.array(consoleLevelSchema),
	lengthThreshold: z.number().int().min(0).max(10_000),
	stringifyOptions: stringifyValuesSchema,
});
const complianceValuesSchema = z.object({
	version: z.string(),
	retentionDays: z.number().int().min(1).max(365),
	rrweb: rrwebValuesSchema,
	console: consoleValuesSchema,
});

export const turretComplianceSchema = complianceValuesSchema.extend({
	version: complianceValuesSchema.shape.version.default("v1"),
	retentionDays: complianceValuesSchema.shape.retentionDays.default(14),
	rrweb: rrwebValuesSchema
		.extend({
			maskAllInputs: rrwebValuesSchema.shape.maskAllInputs.default(true),
		})
		.passthrough()
		.prefault({}),
	console: consoleValuesSchema
		.extend({
			enabled: consoleValuesSchema.shape.enabled.default(true),
			level: consoleValuesSchema.shape.level.default(
				consoleLevelSchema.options
			),
			lengthThreshold:
				consoleValuesSchema.shape.lengthThreshold.default(200),
			stringifyOptions: stringifyValuesSchema
				.extend({
					numOfKeysLimit:
						stringifyValuesSchema.shape.numOfKeysLimit.default(30),
					depthOfLimit:
						stringifyValuesSchema.shape.depthOfLimit.default(2),
				})
				.prefault({ stringLengthLimit: 300 }),
		})
		.passthrough()
		.prefault({}),
});
export type TurretCompliance = z.infer<typeof turretComplianceSchema>;

// Version belongs to stored policy. Updates merge only explicitly supplied settings.
export const turretComplianceUpdateSchema = complianceValuesSchema
	.omit({ version: true })
	.extend({
		rrweb: rrwebValuesSchema.partial().strict(),
		console: consoleValuesSchema
			.extend({
				stringifyOptions: stringifyValuesSchema.partial().strict(),
			})
			.partial()
			.strict(),
	})
	.partial()
	.strict();

export function applyTurretComplianceUpdate(
	current: TurretCompliance,
	update: z.output<typeof turretComplianceUpdateSchema>
): TurretCompliance {
	return turretComplianceSchema.parse({
		...current,
		...update,
		rrweb: { ...current.rrweb, ...update.rrweb },
		console: {
			...current.console,
			...update.console,
			stringifyOptions: {
				...current.console.stringifyOptions,
				...update.console?.stringifyOptions,
			},
		},
	});
}
