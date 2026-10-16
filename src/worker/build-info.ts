// Replaced by Vite's `define` in astro.config.mjs; absent when tests import
// Worker modules directly.
declare const __STACK_COMMIT__: string | null | undefined;

export const buildCommit: string | null =
	typeof __STACK_COMMIT__ === "string" ? __STACK_COMMIT__ : null;
