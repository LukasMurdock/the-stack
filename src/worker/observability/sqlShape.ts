function normalizeSqlShape(sql: string): string {
	let out = sql;

	// Replace string literals with '?'
	out = out.replace(/'(?:''|[^'])*'/g, "?");
	out = out.replace(/"(?:""|[^"])*"/g, "?");

	// Replace numeric literals with '?'
	out = out.replace(/\b\d+(?:\.\d+)?\b/g, "?");

	// Collapse whitespace
	out = out.replace(/\s+/g, " ").trim();

	// Cap to avoid huge spans
	if (out.length > 2000) out = out.slice(0, 2000);
	return out;
}

export { normalizeSqlShape };
