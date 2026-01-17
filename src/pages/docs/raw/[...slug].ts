import { getCollection, getEntry } from "astro:content";

export async function getStaticPaths() {
	const docs = await getCollection("docs");
	return docs.map((doc) => ({
		params: { slug: doc.id },
	}));
}

type GlobMap = Record<string, () => Promise<string>>;

const rawDocs = import.meta.glob("/src/content/docs/**/*.{md,mdx}", {
	query: "?raw",
	import: "default",
}) as GlobMap;

export async function GET({ params }: { params: { slug: string } }) {
	const entry = await getEntry("docs", params.slug);
	if (!entry?.filePath) {
		return new Response("Not found", { status: 404 });
	}

	const key = `/${entry.filePath}`;
	const loader = rawDocs[key];
	if (!loader) {
		return new Response("Not found", { status: 404 });
	}

	const raw = await loader();

	return new Response(raw, {
		headers: {
			"Content-Type": "text/markdown; charset=utf-8",
			"Cache-Control": "public, max-age=0, must-revalidate",
		},
	});
}
