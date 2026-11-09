// How a feedback report reads in the inbox. Reports are whatever someone typed
// and whatever page they were on, so nothing here assumes their shape.

// What a report's area and links may open: http and https only, since the URL
// comes from the reporter's browser.
export function webUrl(value: string | null | undefined) {
	if (!value) return null;
	try {
		const url = new URL(value);
		return url.protocol === "https:" || url.protocol === "http:"
			? url
			: null;
	} catch {
		return null;
	}
}

// Sections whose address doesn't read as a name. Add an app's own here.
const areas: Record<string, string> = { ts_admin: "Admin" };

// The part of the app a report came from: /app/orders/6011… is "Orders".
export function reportArea(url: string | null | undefined) {
	const parsed = webUrl(url);
	if (!parsed) return null;
	const [first, second] = parsed.pathname.split("/").filter(Boolean);
	const section = first === "app" ? second : first;
	if (!section) return "Home";
	return (
		areas[section] ??
		`${section.charAt(0).toUpperCase()}${section.slice(1)}`.replace(
			/[-_]/g,
			" "
		)
	);
}

// A report's address without its origin, to read where it points.
export function reportPath(url: string | null | undefined) {
	const parsed = webUrl(url);
	return parsed ? `${parsed.pathname}${parsed.search}` : null;
}

const SENTENCE_END = /^(.+?[.!?])(?:\s|$)/;

// A report's opening, to scan by, and the rest of it as one line to preview.
export function reportSummary(message: string) {
	const text = message.trim();
	const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
	const headline = SENTENCE_END.exec(firstLine)?.[1] ?? firstLine;
	return {
		headline,
		preview: text
			.slice(headline.length)
			// A "-Name" sign-off says nothing in a preview.
			.replace(/\n\s*-\s*\S+\s*$/, "")
			.replace(/\n\s*(?:[-*•]\s+|-(?=\S+\s))/g, " · ")
			.replace(/^\s*(?:[-*•]\s+|-(?=\S+\s))/, "")
			.replace(/\s+/g, " ")
			.replace(/: · /g, ": ")
			.replace(/^[\s:;,.·–—-]+/, "")
			.trim(),
	};
}

export type MessageBlock =
	| { kind: "paragraph"; text: string }
	| { kind: "heading"; text: string }
	| { kind: "list"; items: string[] };

// "- item", and "-item" when it runs on, which isn't a "-Name" sign-off.
const LIST_ITEM = /^\s*(?:[-*•]\s+|-(?=\S+\s))(.+)$/;
const LABEL_LINE = /^[^.!?]{1,48}:$/;

// A long report's own structure, so notes read as written: blank lines part
// paragraphs, dashes make lists, and a short line ending in a colon heads
// what follows. Anything else stays the sentence it was.
export function messageBlocks(message: string): MessageBlock[] {
	const blocks: MessageBlock[] = [];
	let paragraph: string[] = [];
	const closeParagraph = () => {
		if (paragraph.length)
			blocks.push({ kind: "paragraph", text: paragraph.join("\n") });
		paragraph = [];
	};
	for (const raw of message.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			closeParagraph();
			continue;
		}
		const item = LIST_ITEM.exec(raw)?.[1]?.trim();
		if (item) {
			closeParagraph();
			const last = blocks.at(-1);
			if (last?.kind === "list") last.items.push(item);
			else blocks.push({ kind: "list", items: [item] });
			continue;
		}
		if (LABEL_LINE.test(line)) {
			closeParagraph();
			blocks.push({ kind: "heading", text: line.slice(0, -1) });
			continue;
		}
		paragraph.push(line);
	}
	closeParagraph();
	return blocks;
}

// Text and the web addresses in it, for showing the addresses as links.
export function linkParts(text: string) {
	const parts: ({ text: string } | { text: string; href: string })[] = [];
	let end = 0;
	for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
		const address = match[0].replace(/[.,;:!?)\]]+$/, "");
		const href = webUrl(address)?.toString();
		if (!href) continue;
		if (match.index > end)
			parts.push({ text: text.slice(end, match.index) });
		parts.push({ text: address, href });
		end = match.index + address.length;
	}
	if (end < text.length) parts.push({ text: text.slice(end) });
	return parts;
}

// A reporter's name as an address starts: "ascala@…" reads "ascala". Whoever
// has no address keeps their id.
export function reporterName(reporter: string) {
	return reporter.split("@", 1)[0] || reporter;
}

// Who sent it, as two letters to recognize: "ascala@…" reads "AS".
export function reporterInitials(reporter: string) {
	const name = reporter.split("@", 1)[0] ?? reporter;
	const words = name.split(/[._\-+\s]+/).filter(Boolean);
	const letters =
		words.length > 1
			? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`
			: name.slice(0, 2);
	return letters.toUpperCase();
}
