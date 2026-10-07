import { z } from "zod";
import { resourceIdSchema } from "../../contracts/operation";
export const createProjectSchema = z.object({
	name: z
		.string()
		.trim()
		.min(1, "Enter a name.")
		.max(120, {
			error: (issue) => `Use ${issue.maximum} characters or fewer.`,
		}),
	description: z
		.string()
		.trim()
		.max(2000, {
			error: (issue) =>
				`Use ${issue.maximum.toLocaleString("en-US")} characters or fewer.`,
		}),
});
export const projectSchema = createProjectSchema.extend({
	id: resourceIdSchema,
	organizationId: resourceIdSchema,
	createdAt: z.number(),
});
export const projectResponseSchema = z.object({ project: projectSchema });
export const projectsResponseSchema = z.object({
	projects: z.array(projectSchema),
});
export type Project = z.infer<typeof projectSchema>;
