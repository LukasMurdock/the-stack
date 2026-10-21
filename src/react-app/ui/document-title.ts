import { useEffect, type RefObject } from "react";
import { appName } from "../components/nav-items";

export function documentTitle(heading: string | null | undefined) {
	const page = heading?.replace(/\s+/g, " ").trim();
	return page && page !== appName ? `${page} · ${appName}` : appName;
}

// The tab title follows the page's only h1, so it names the record or list
// the person is looking at (role-specific labels and renames included)
// without each route repeating its heading.
export function useDocumentTitle(root: RefObject<HTMLElement | null>) {
	useEffect(() => {
		const element = root.current;
		if (!element) return;
		let frame = 0;
		const update = () => {
			frame = 0;
			const title = documentTitle(
				element.querySelector("h1")?.textContent
			);
			if (document.title !== title) document.title = title;
		};
		update();
		const observer = new MutationObserver(() => {
			frame ||= requestAnimationFrame(update);
		});
		observer.observe(element, {
			childList: true,
			subtree: true,
			characterData: true,
		});
		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
		};
	}, [root]);
}
