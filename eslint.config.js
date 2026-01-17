import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import pluginQuery from "@tanstack/eslint-plugin-query";
import pluginRouter from "@tanstack/eslint-plugin-router";
import drizzle from "eslint-plugin-drizzle";

export default defineConfig(
	{ ignores: ["dist", "**/routeTree.gen.ts"] },
	{
		extends: [
			js.configs.recommended,
			...tseslint.configs.recommended,
			...pluginQuery.configs["flat/recommended"],
			...pluginRouter.configs["flat/recommended"],
		],
		files: ["**/*.{ts,tsx}"],
		languageOptions: {
			ecmaVersion: 2020,
			globals: globals.browser,
		},
		plugins: {
			"react-hooks": reactHooks,
			"react-refresh": reactRefresh,
			drizzle,
		},
		rules: {
			...reactHooks.configs.recommended.rules,
			"react-refresh/only-export-components": [
				"warn",
				{ allowConstantExport: true },
			],
			...drizzle.configs.recommended.rules,
		},
	}
);
