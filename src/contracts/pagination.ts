import { z } from "zod";
export const PAGE_SIZE = 50;
export const PAGE_OFFSET_MAX = 100_000;
export const pageSchema = z.object({
	offset: z.coerce.number().int().min(0).max(PAGE_OFFSET_MAX).default(0),
});

// Where a page sits in everything the list's filters matched.
export const pageInfoSchema = z.object({
	offset: z.number().int().min(0),
	total: z.number().int().min(0),
});
export type PageInfo = z.infer<typeof pageInfoSchema>;

// A paged list response: rows under their resource key, plus the page.
export function pagedResponse<Shape extends z.ZodRawShape>(shape: Shape) {
	return z.object(shape).extend({ page: pageInfoSchema });
}
