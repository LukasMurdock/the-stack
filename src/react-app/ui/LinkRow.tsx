import { ExternalLink } from "lucide-react";
import { unitRowClass } from "./Unit";

// A link that opens elsewhere (a document, another tool) as a row: the whole
// row opens it in a new tab. Use inside a Unit's `<ul className="-mx-3">`.
export function LinkRow({
	url,
	title,
	detail,
}: {
	url: string;
	title: string;
	detail?: string;
}) {
	return (
		<li>
			<a
				href={url}
				target="_blank"
				rel="noreferrer noopener"
				className={unitRowClass}
			>
				<span className="min-w-0 flex-1 space-y-0.5">
					<span className="block font-medium">{title}</span>
					{detail && (
						<span className="block truncate text-sm text-muted-foreground">
							{detail}
						</span>
					)}
				</span>
				<ExternalLink
					aria-hidden
					className="size-4 shrink-0 text-muted-foreground"
				/>
			</a>
		</li>
	);
}
