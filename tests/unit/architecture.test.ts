import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../..");
const manifest = z
	.object({
		dependencies: z.record(z.string(), z.string()),
		devDependencies: z.record(z.string(), z.string()),
	})
	.parse(JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")));
const packages = new Set([
	...Object.keys(manifest.dependencies),
	...Object.keys(manifest.devDependencies),
]);

function files(directory: string) {
	return readdirSync(resolve(root, directory), {
		recursive: true,
		encoding: "utf8",
	})
		.filter(
			(name) =>
				/\.(?:[cm]?js|tsx?|astro)$/.test(name) &&
				!name.endsWith(".d.ts") &&
				!name.endsWith(".gen.ts")
		)
		.map((name) => resolve(root, directory, name));
}

test("source, scripts and tests import only declared packages and respect browser runtime boundaries", () => {
	const violations: string[] = [];
	for (const filename of [
		...files("src"),
		...files("scripts"),
		...files("tests"),
		...files("tools"),
	]) {
		const path = relative(root, filename);
		const text = readFileSync(filename, "utf8");
		const source = ts.createSourceFile(
			filename,
			filename.endsWith(".astro") ? (text.split("---")[1] ?? "") : text,
			ts.ScriptTarget.Latest,
			true
		);
		const browser =
			/^(?:src\/(?:react-app|components|contracts|lib)\/|src\/features\/[^/]+\/(?:policy|contracts)\.ts$)/.test(
				path
			);
		function check(specifier: string, typeOnly: boolean) {
			if (isBuiltin(specifier) || /^[a-z][\w-]*:/.test(specifier)) return;
			if (!specifier.startsWith(".") && !specifier.startsWith("@/")) {
				const name = specifier
					.split("/")
					.slice(0, specifier.startsWith("@") ? 2 : 1)
					.join("/");
				if (!packages.has(name))
					violations.push(`${path}: undeclared package ${name}`);
				return;
			}
			const target = specifier.startsWith("@/")
				? resolve(root, "src", specifier.slice(2))
				: resolve(dirname(filename), specifier);
			if (
				browser &&
				!typeOnly &&
				/^src\/(?:(?:worker|bindings)(?:\/|$)|features\/(?:[^/]+\/(?:operations|authorization|members|invitations|http)|shared\/context)(?:\.ts|$))/.test(
					relative(root, target)
				)
			)
				violations.push(
					`${path}: browser runtime imports ${specifier}`
				);
		}
		function visit(node: ts.Node) {
			if (
				ts.isImportDeclaration(node) &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				const clause = node.importClause;
				const named = clause?.namedBindings;
				check(
					node.moduleSpecifier.text,
					clause?.isTypeOnly === true ||
						Boolean(
							!clause?.name &&
							named &&
							ts.isNamedImports(named) &&
							named.elements.length > 0 &&
							named.elements.every((item) => item.isTypeOnly)
						)
				);
			} else if (
				ts.isExportDeclaration(node) &&
				node.moduleSpecifier &&
				ts.isStringLiteral(node.moduleSpecifier)
			) {
				check(node.moduleSpecifier.text, node.isTypeOnly);
			} else if (
				ts.isImportTypeNode(node) &&
				ts.isLiteralTypeNode(node.argument) &&
				ts.isStringLiteral(node.argument.literal)
			) {
				check(node.argument.literal.text, true);
			} else if (
				ts.isCallExpression(node) &&
				node.arguments.length &&
				ts.isStringLiteral(node.arguments[0]) &&
				(node.expression.kind === ts.SyntaxKind.ImportKeyword ||
					(ts.isIdentifier(node.expression) &&
						node.expression.text === "require"))
			) {
				check(node.arguments[0].text, false);
			}
			ts.forEachChild(node, visit);
		}
		visit(source);
	}
	assert.deepEqual(violations, []);
});

test("literal search and migration fixtures retain a single owner", () => {
	for (const filename of files("src"))
		assert.doesNotMatch(
			readFileSync(filename, "utf8"),
			/function escapeLike\b/,
			relative(root, filename)
		);
	for (const filename of [
		...files("tests/integration"),
		...files("tests/smoke"),
	]) {
		const source = readFileSync(filename, "utf8");
		assert.ok(
			!(source.includes("CREATE TABLE") && source.includes(".match(")),
			`${relative(root, filename)} reconstructs migration fragments`
		);
	}
});
