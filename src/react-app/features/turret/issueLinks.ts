// Names a tracking link the way people refer to it: "owner/repo#42" for
// GitHub pull requests and issues, otherwise the host and path.
export function describeIssueLink(url: string): {
	label: string;
	kind: "pull request" | "issue" | "link";
} {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return { label: url, kind: "link" };
	}
	const github = /^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/.exec(
		parsed.pathname
	);
	if (parsed.hostname === "github.com" && github) {
		const [, owner, repo, type, number] = github;
		return {
			label: `${owner}/${repo}#${number}`,
			kind: type === "pull" ? "pull request" : "issue",
		};
	}
	const path = parsed.pathname === "/" ? "" : parsed.pathname;
	return { label: `${parsed.hostname}${path}`, kind: "link" };
}
