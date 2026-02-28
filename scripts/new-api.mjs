import fs from "node:fs";
import path from "node:path";

function die(message) {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

function toKebab(value) {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function toCamel(value) {
	return value.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}

const rawName = process.argv[2];
if (!rawName) {
	die(
		"Usage: node scripts/new-api.mjs <route-name>\nExample: node scripts/new-api.mjs billing-status"
	);
}

const routeName = toKebab(rawName);
if (!routeName) {
	die("Invalid route name.");
}

const routeVar = toCamel(routeName);
const appVar = `${routeVar}App`;
const routeAlias = `${routeVar}Routes`;
const filePath = path.resolve(
	process.cwd(),
	`src/worker/api/routes/${routeName}.ts`
);
const apiIndexPath = path.resolve(process.cwd(), "src/worker/api/index.ts");

if (fs.existsSync(filePath)) {
	die(`Route file already exists: ${filePath}`);
}

const title = routeName
	.split("-")
	.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
	.join(" ");

const routeTemplate = `import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";

const ${appVar} = new OpenAPIHono();

const get${routeVar.charAt(0).toUpperCase() + routeVar.slice(1)} = createRoute({
	method: "get",
	path: "/${routeName}",
	responses: {
		200: {
			description: "${title}",
			content: {
				"application/json": {
					schema: z.object({ ok: z.boolean() }),
				},
			},
		},
	},
});

const routes = ${appVar}.openapi(get${routeVar.charAt(0).toUpperCase() + routeVar.slice(1)}, (c) => {
	return c.json({ ok: true }, 200);
});

export { ${appVar}, routes };
`;

fs.writeFileSync(filePath, routeTemplate);

const apiIndex = fs.readFileSync(apiIndexPath, "utf8");
const importLine = `import { routes as ${routeAlias} } from "./routes/${routeName}";`;

if (!apiIndex.includes(importLine)) {
	const anchor = "const api = new OpenAPIHono();";
	const idx = apiIndex.indexOf(anchor);
	if (idx === -1) {
		die(`Could not find import insertion anchor in ${apiIndexPath}`);
	}
	const withImport =
		apiIndex.slice(0, idx) + `${importLine}\n` + apiIndex.slice(idx);

	const routeBlockNeedle = "const apiRoutes = api";
	const functionNeedle = "\n\nfunction isAdminRole";
	const routeStart = withImport.indexOf(routeBlockNeedle);
	const functionStart = withImport.indexOf(functionNeedle);
	if (
		routeStart === -1 ||
		functionStart === -1 ||
		functionStart <= routeStart
	) {
		die(`Could not find route-chain insertion anchors in ${apiIndexPath}`);
	}

	const routeBlock = withImport.slice(routeStart, functionStart);
	if (routeBlock.includes(`.route("/", ${routeAlias})`)) {
		fs.writeFileSync(apiIndexPath, withImport);
	} else {
		const updatedRouteBlock = routeBlock.replace(
			/(\n\t\.route\("\/", [A-Za-z0-9_]+\))(\s*;\s*)$/,
			`$1\n\t.route("/", ${routeAlias})$2`
		);

		if (updatedRouteBlock === routeBlock) {
			die(`Could not append route chain entry in ${apiIndexPath}`);
		}

		const updated =
			withImport.slice(0, routeStart) +
			updatedRouteBlock +
			withImport.slice(functionStart);
		fs.writeFileSync(apiIndexPath, updated);
	}
}

process.stdout.write(
	`Created API route: src/worker/api/routes/${routeName}.ts\n`
);
process.stdout.write(`Wired route into: src/worker/api/index.ts\n`);
