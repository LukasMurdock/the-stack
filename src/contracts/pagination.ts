import { z } from "zod";
export const PAGE_SIZE = 50;
export const PAGE_OFFSET_MAX = 100_000;
export const pageSchema = z.object({
	offset: z.coerce.number().int().min(0).max(PAGE_OFFSET_MAX).default(0),
});
