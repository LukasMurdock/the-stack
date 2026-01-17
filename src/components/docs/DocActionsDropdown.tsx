import * as React from "react";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import {
	ChevronDownIcon,
	CopyIcon,
	ExternalLinkIcon,
	SparklesIcon,
} from "lucide-react";

type DocActionsDropdownProps = {
	url: string;
};

export function DocActionsDropdown({ url }: DocActionsDropdownProps) {
	const [copyStatus, setCopyStatus] = React.useState("Copy Markdown");
	const [dropdownOpen, setDropdownOpen] = React.useState(false);

	const fetchMarkdown = React.useCallback(async () => {
		try {
			const response = await fetch(url);
			if (!response.ok) return null;
			return await response.text();
		} catch (error) {
			console.error("Failed to fetch markdown content:", error);
			return null;
		}
	}, [url]);

	const handleAskGPT = React.useCallback(() => {
		const content = encodeURIComponent(
			"Please read the contents from the following link so i can ask question about it: " +
				url
		);
		window.open(
			`https://chatgpt.com/?q=${content}`,
			"_blank",
			"noopener,noreferrer"
		);
	}, [url]);

	const handleAskClaude = React.useCallback(() => {
		const content = encodeURIComponent(
			"Please read the contents from the following link so i can ask question about it: " +
				url
		);
		window.open(
			`https://claude.ai/new?q=${content}`,
			"_blank",
			"noopener,noreferrer"
		);
	}, [url]);

	const handleCopyMarkdown = React.useCallback(async () => {
		const markdownContent = await fetchMarkdown();
		if (!markdownContent) {
			setCopyStatus("Failed");
			return;
		}

		try {
			await navigator.clipboard.writeText(markdownContent);
			setCopyStatus("Copied!");
			window.setTimeout(() => setCopyStatus("Copy Markdown"), 2000);
		} catch (error) {
			console.error("Failed to copy to clipboard:", error);
			setCopyStatus("Failed");
		}
	}, [fetchMarkdown]);

	const handleViewMarkdown = React.useCallback(() => {
		window.open(url, "_blank", "noopener,noreferrer");
	}, [url]);

	return (
		<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
			<DropdownMenuTrigger
				onClick={() => setDropdownOpen((val) => !val)}
				className="not-prose group relative flex w-fit flex-nowrap rounded-sm border border-black/15 py-1.5 px-2 transition-colors duration-300 ease-in-out hover:bg-black/5 hover:text-black focus-visible:bg-black/5 focus-visible:text-black dark:border-white/20 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:bg-white/5 dark:focus-visible:text-white text-sm items-center justify-center gap-1.5"
			>
				<div className="flex items-center justify-center gap-1.5 divide-x divide-border">
					<div className="flex items-center justify-center gap-1.5 pr-1.5">
						<CopyIcon className="size-3" />
						<span>Copy Page</span>
					</div>
					<div className="flex items-center justify-center gap-1.5">
						<ChevronDownIcon className="size-3 transition-transform duration-300 ease-in-out group-data-[state=open]:rotate-180" />
					</div>
				</div>
			</DropdownMenuTrigger>

			<DropdownMenuContent align="end" className="min-w-[10rem]">
				<DropdownMenuItem onClick={handleAskGPT}>
					<SparklesIcon className="size-3" />
					<span>Ask GPT</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleAskClaude}>
					<SparklesIcon className="size-3" />
					<span>Ask Claude</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleCopyMarkdown}>
					<span>{copyStatus}</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleViewMarkdown}>
					<ExternalLinkIcon className="size-3" />
					<span>View Markdown</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
