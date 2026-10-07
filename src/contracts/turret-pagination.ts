import { z } from "zod";
import { pageSchema } from "./pagination";

export const turretListPageSchema = pageSchema.extend({
	limit: z.coerce.number().int().min(1).max(200).default(50),
});
export const turretBreadcrumbPageSchema = turretListPageSchema.extend({
	limit: turretListPageSchema.shape.limit.unwrap().default(200),
});
export const turretSpanPageSchema = pageSchema.extend({
	limit: z.coerce.number().int().min(1).max(5000).default(5000),
});
export const turretListPageDefaults = turretListPageSchema.parse({});
export const turretBreadcrumbPageDefaults = turretBreadcrumbPageSchema.parse(
	{}
);
export const turretSpanPageDefaults = turretSpanPageSchema.parse({});
