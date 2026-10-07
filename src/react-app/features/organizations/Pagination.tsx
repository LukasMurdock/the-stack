import { Button } from "@/components/ui/button";
import { PAGE_SIZE, PAGE_OFFSET_MAX } from "../../../contracts/pagination";
export function Pagination({
	offset,
	count,
	onPage,
}: {
	offset: number;
	count: number;
	onPage: (offset: number) => void;
}) {
	return (
		<nav aria-label="Pagination" className="flex items-center gap-3">
			<Button
				variant="outline"
				disabled={offset === 0}
				onClick={() => onPage(Math.max(0, offset - PAGE_SIZE))}
			>
				Previous
			</Button>
			<span className="text-sm">Page {offset / PAGE_SIZE + 1}</span>
			<Button
				variant="outline"
				disabled={count < PAGE_SIZE || offset >= PAGE_OFFSET_MAX}
				onClick={() => onPage(offset + PAGE_SIZE)}
			>
				Next
			</Button>
		</nav>
	);
}
