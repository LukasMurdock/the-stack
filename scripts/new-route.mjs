import fs from "node:fs";
import path from "node:path";

function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function toKebabSegment(value) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function toPascal(value) {
	return value
		.split(/[^a-zA-Z0-9]+/)
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

const rawRoute = process.argv[2];
if (!rawRoute) {
	die(
		"Usage: node scripts/new-route.mjs <route-path>\n" +
			"Examples:\n" +
			"  node scripts/new-route.mjs _public/reports\n" +
			"  node scripts/new-route.mjs ts_admin/ops/index"
	);
}

const normalized = rawRoute
	.split("/")
	.map((segment) => segment.trim())
	.filter(Boolean)
	.map((segment) => {
		if (segment.startsWith("$") || segment.startsWith("_")) return segment;
		return toKebabSegment(segment);
	})
	.join("/");

if (!normalized) {
	die("Invalid route path.");
}

const routeId = `/${normalized.endsWith("/index") ? `${normalized.slice(0, -"/index".length)}/` : normalized}`;
const filePath = path.resolve(
	process.cwd(),
	`src/react-app/routes/${normalized}.tsx`
);

if (fs.existsSync(filePath)) {
	die(`Route file already exists: ${filePath}`);
}

fs.mkdirSync(path.dirname(filePath), { recursive: true });

const pageNameBase = normalized.endsWith("/index")
	? normalized.slice(0, -"/index".length)
	: normalized;
const pageName = `${toPascal(
	pageNameBase
		.split("/")
		.filter((s) => !s.startsWith("_"))
		.join(" ") || "Page"
)}Page`;
const title = pageName
	.replace(/Page$/, "")
	.replace(/([a-z])([A-Z])/g, "$1 $2")
	.trim();

const template = `import { createFileRoute } from "@tanstack/react-router";

const Route = createFileRoute("${routeId}")({
	component: ${pageName},
});

function ${pageName}() {
	return (
		<section className="space-y-4">
			<div className="space-y-1">
				<h1 className="text-2xl font-semibold tracking-tight">${title || "New Route"}</h1>
				<p className="text-sm text-muted-foreground">Generated route scaffold.</p>
			</div>
		</section>
	);
}

export { Route };
`;

fs.writeFileSync(filePath, template);

process.stdout.write(
	`Created route file: src/react-app/routes/${normalized}.tsx\n`
);
process.stdout.write("Next: run `just dev` to regenerate routeTree.gen.ts\n");
