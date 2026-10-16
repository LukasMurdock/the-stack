import { readFileSync } from "node:fs";

// Void 0.28 exposes one inferred D1 through its CLI. Reuse its own provisioning
// engine for every declared database instead of implementing Cloudflare calls.
// These internal entry points are deliberately isolated and version-checked.
export async function loadVoidProvisioning() {
	const entry = import.meta.resolve("void");
	const { version } = JSON.parse(
		readFileSync(new URL("../package.json", entry), "utf8")
	);
	if (version !== "0.28.0")
		throw new Error(
			`Update and validate the multi-database adapter before using Void ${version}.`
		);
	const { l: provisionCloudflareResources } = await import(
		new URL("./provision-DDh7ITVS.mjs", entry).href
	);
	// persistCloudflareConfig records a Flagship app_id written into the
	// materialized config in void.lock.json, as Void does for its own IDs.
	const { r: materializeCloudflareConfig, i: persistCloudflareConfig } =
		await import(new URL("./cloudflare-config-DV60XFFK.mjs", entry).href);
	return {
		provisionCloudflareResources,
		materializeCloudflareConfig,
		persistCloudflareConfig,
	};
}
