import { z } from "zod";

const featureValuesSchema = z.object({
	storeUserEmail: z.boolean(),
});
// Updates use the validators directly: adding a flag cannot apply a stored default to an omitted patch field.
export const turretFeaturesUpdateSchema = featureValuesSchema
	.partial()
	.strict();
export const turretFeaturesSchema = featureValuesSchema.extend({
	storeUserEmail: featureValuesSchema.shape.storeUserEmail.default(true),
});
export type TurretFeatures = z.output<typeof turretFeaturesSchema>;
