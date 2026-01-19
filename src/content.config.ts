import { z } from "astro/zod";
import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";

const docs = defineCollection({
	// Load Markdown and MDX files in the `src/content/docs/` directory.
	loader: glob({ base: "./src/content/docs", pattern: "**/*.{md,mdx}" }),
	// Type-check frontmatter using a schema
	schema: ({ image }) =>
		z.object({
			title: z.string(),
			description: z.string(),
			// Transform string to Date object
			pubDate: z.coerce.date(),
			updatedDate: z.coerce.date().optional(),
			heroImage: image().optional(),
		}),
});

export const collections = { docs };
