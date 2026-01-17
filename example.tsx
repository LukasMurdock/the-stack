import { useState, type SVGProps } from "react";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";

interface BlogActionsDropdownReactProps {
	url: string;
}

export default function BlogActionsDropdownReact({
	url,
}: BlogActionsDropdownReactProps) {
	const [copyStatus, setCopyStatus] = useState<string>("Copy Markdown");

	const [dropdownOpen, setDropdownOpen] = useState(false);

	const fetchMarkdown = async () => {
		try {
			const response = await fetch(url);
			if (response.ok) {
				const content = await response.text();
				return content;
			}
		} catch (error) {
			console.error("Failed to fetch markdown content:", error);
		}
	};

	const handleAskGPT = () => {
		const content = encodeURIComponent(
			"Please read the contents from the following link so i can ask question about it: " +
				url
		);
		const chatGptUrl = `https://chatgpt.com/?q=${content}`;
		window.open(chatGptUrl, "_blank", "noopener,noreferrer");
	};

	const handleAskClaude = () => {
		const content = encodeURIComponent(
			"Please read the contents from the following link so i can ask question about it: " +
				url
		);
		const chatClaudeUrl = `https://claude.ai/new?q=${content}`;
		window.open(chatClaudeUrl, "_blank", "noopener,noreferrer");
	};

	const handleCopyMarkdown = async () => {
		const markdownContent = await fetchMarkdown();
		if (!markdownContent) {
			setCopyStatus("Failed");
			return;
		}
		try {
			await navigator.clipboard.writeText(markdownContent);
			setCopyStatus("Copied!");
			setTimeout(() => {
				setCopyStatus("Copy Markdown");
			}, 2000);
		} catch (error) {
			console.error("Failed to copy to clipboard:", error);
		}
	};

	const handleViewMarkdown = () => {
		window.open(url, "_blank", "noopener,noreferrer");
	};

	return (
		<DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
			<DropdownMenuTrigger
				onClick={() => setDropdownOpen((val) => !val)}
				className="not-prose group relative flex w-fit flex-nowrap rounded-sm border border-black/15 py-1.5 px-2 transition-colors duration-300 ease-in-out hover:bg-black/5 hover:text-black focus-visible:bg-black/5 focus-visible:text-black dark:border-white/20 dark:hover:bg-white/5 dark:hover:text-white dark:focus-visible:bg-white/5 dark:focus-visible:text-white text-sm items-center justify-center gap-1.5"
			>
				<div className="flex items-center justify-center gap-1.5 divide-x divide-border">
					<div className="flex items-center justify-center gap-1.5 pr-1.5">
						<IconCopy className="size-3" />
						<span>Copy Page</span>
					</div>
					<div className="flex items-center justify-center gap-1.5">
						<IconChevronDown className="size-3 transition-transform duration-300 ease-in-out group-data-[state=open]:rotate-180" />
					</div>
				</div>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-[8rem]">
				<DropdownMenuItem onClick={handleAskGPT}>
					<IconOpenai className="size-3" />
					<span>Ask GPT</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleAskClaude}>
					<IconClaude className="size-3" />
					<span>Ask Claude</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleCopyMarkdown}>
					<span>{copyStatus}</span>
				</DropdownMenuItem>
				<DropdownMenuItem onClick={handleViewMarkdown}>
					<span>View Markdown</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
