import { copyFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";

// Astro reads this pointer before creating Vite's preview server. Void stashes
// it after a build to prevent implicit Wrangler publication; restore it here
// before Astro starts, since Void's Vite hook runs too late for Astro 7.
mkdirSync(".wrangler/deploy", { recursive: true });
copyFileSync(
	".void/preview-deploy-config.json",
	".wrangler/deploy/config.json"
);
execFileSync("pnpm", ["exec", "astro", "preview", ...process.argv.slice(2)], {
	stdio: "inherit",
});
