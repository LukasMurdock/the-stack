import { Button } from "@/components/ui/button";
import {
	PAGE_OFFSET_MAX,
	PAGE_SIZE,
	type PageInfo,
} from "@/contracts/pagination";

const count = (value: number) => value.toLocaleString("en-US");

// Previous and next for a pagedResponse list, with where the page sits in
// everything matched. Hidden while one page holds it all; shown whenever off
// the first page, so a page emptied by changes elsewhere can still be left.
export function Pagination({
	page,
	onPage,
}: {
	page: PageInfo | undefined;
	onPage: (offset: number) => void;
}) {
	if (!page || (page.offset === 0 && page.total <= PAGE_SIZE)) return null;
	const { offset, total } = page;
	const end = Math.min(offset + PAGE_SIZE, total);
	return (
		<nav aria-label="Pagination" className="flex items-center gap-3">
			<Button
				variant="outline"
				disabled={offset === 0}
				onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
			>
				Previous
			</Button>
			<span className="text-sm tabular-nums">
				{offset < total
					? `${count(offset + 1)}–${count(end)} of ${count(total)}`
					: `Page ${count(offset / PAGE_SIZE + 1)}`}
			</span>
			<Button
				variant="outline"
				disabled={end >= total || offset >= PAGE_OFFSET_MAX}
				onClick={() => onPage(offset + PAGE_SIZE)}
			>
				Next
			</Button>
		</nav>
	);
}
