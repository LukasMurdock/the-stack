import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} message
 * @returns {never}
 */
function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

/** @param {string} value */
function toKebabSegment(value) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_$-]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** @param {string} value */
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
		"Usage: pnpm routes:new <route-path>\n" +
			"Examples:\n" +
			"  pnpm routes:new _public/reports\n" +
			"  pnpm routes:new ts_admin/ops/index"
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
process.stdout.write(
	"Next: run `pnpm routes` to regenerate routeTree.gen.ts\n"
);
