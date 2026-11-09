import {
	keepPreviousData,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import {
	ArrowLeft,
	Bug,
	ChevronDown,
	ChevronUp,
	CheckCheck,
	CircleCheck,
	ExternalLink,
	FolderSearch,
	Keyboard,
	Lightbulb,
	Link2,
	Mail,
	type LucideIcon,
	MessageSquare,
	PlayCircle,
	RotateCcw,
	Search,
	Sparkles,
	X,
} from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
	type ComponentProps,
	type ReactNode,
	type Ref,
} from "react";
import type { z } from "zod";
import { Button, buttonVariants } from "@/components/ui/button";
import {
	Empty,
	EmptyContent,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { PAGE_SIZE } from "@/contracts/pagination";
import {
	turretFeedbackKindSchema,
	turretFeedbackStatusSchema,
} from "@/contracts/turret";
import { cn } from "@/lib/utils";
import { Pagination } from "../../../ui/Pagination";
import {
	appName,
	tabActiveProps,
	tabLinkClass,
} from "../../../components/nav-items";
import { StatusPill } from "../../../ui/StatusPill";
import { formatAgo, formatDateTime, plural } from "../../../ui/format";
import { toneClasses, type Tone } from "../../../ui/tone";
import { REPLAY_LEAD_MS } from "../investigation/timeline";
import {
	turretFeedbackIssueMutation,
	turretFeedbackQueryOptions,
	turretFeedbackStatusMutation,
	turretKeys,
	type TurretFeedbackItem as Report,
} from "../queries";
import {
	linkParts,
	messageBlocks,
	reportArea,
	reporterInitials,
	reporterName,
	reportPath,
	reportSummary,
	webUrl,
} from "./report";

type Status = z.infer<typeof turretFeedbackStatusSchema>;
type Kind = z.infer<typeof turretFeedbackKindSchema>;
export type InboxSearch = {
	status: Status;
	kind?: Kind;
	q: string;
	id?: string;
	offset: number;
};

const statusLabels = {
	open: "New",
	triaged: "Triaged",
	resolved: "Resolved",
} satisfies Record<Status, string>;
const statusTones = {
	open: "waiting",
	triaged: "working",
	resolved: "done",
} satisfies Record<Status, Tone>;
// Status owns the state colors; only a bug, which may need action now, takes
// one on top of its icon.
const kinds = {
	bug: { label: "Bug", icon: Bug, tone: "stopped" },
	idea: { label: "Idea", icon: Lightbulb, tone: "neutral" },
	praise: { label: "Praise", icon: Sparkles, tone: "neutral" },
	other: { label: "Note", icon: MessageSquare, tone: "neutral" },
} satisfies Record<Kind, { label: string; icon: LucideIcon; tone: Tone }>;

const INBOX = "/ts_admin/turret/feedback";
const focusRing =
	"rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const WIDE = "(min-width: 64rem)";
const SHORTCUTS_KEY = "feedback-shortcuts";
const reporterOf = (report: Report) => report.userEmail ?? report.userId;
const STATUS_MUTATION = ["turret-feedback-status"];

type ListKey = ReturnType<typeof turretFeedbackQueryOptions>["queryKey"];
const NO_REPORTS: Report[] = [];

type Decided = {
	report: Report;
	index: number;
	to: Status;
	// Where it was decided, which undo returns to.
	search: InboxSearch;
	key: ListKey;
};

// Everyone's feedback in one place: what's new, read in full, decided with a
// key, and on to the next. The filters and the open report live in the URL, so
// a report can be linked to and Back works. Decisions show at once and are
// undone the same way; the server catches up behind them.
export function FeedbackInbox({ search }: { search: InboxSearch }) {
	const navigate = useNavigate();
	const router = useRouter();
	const queryClient = useQueryClient();
	const go = useCallback(
		(change: Partial<InboxSearch>, replace = false) => {
			// Something finishing late mustn't bring back someone who has left.
			if (!router.latestLocation.pathname.endsWith("/turret/feedback"))
				return;
			void navigate({
				from: "/ts_admin/turret/feedback/",
				to: INBOX,
				search: (previous: InboxSearch) => ({ ...previous, ...change }),
				replace,
			});
		},
		[navigate, router]
	);

	// Everything retained, not a recent window: a report still waiting for an
	// answer doesn't stop waiting. No end time, so new reports arrive.
	const list = turretFeedbackQueryOptions({
		status: search.status,
		kind: search.kind,
		q: search.q.trim() || undefined,
		from: 0,
		limit: PAGE_SIZE,
		offset: search.offset,
	});
	const listKey = list.queryKey;
	const query = useQuery({
		...list,
		placeholderData: keepPreviousData,
		refetchInterval: 60_000,
	});
	const stale = query.isPlaceholderData;
	const reports = query.data?.feedback ?? NO_REPORTS;
	const counts = query.data?.counts;
	// The last report read stays marked in the list, so Back keeps the place.
	const [lastRead, setLastRead] = useState(search.id);
	if (search.id && search.id !== lastRead) setLastRead(search.id);
	// A decision opens the next report at once; the URL catches up a moment later.
	const [moving, setMoving] = useState<{ from: string; to?: string } | null>(
		null
	);
	// Once the URL has moved on, it decides again.
	if (moving && moving.from !== search.id) setMoving(null);
	const openId = moving && moving.from === search.id ? moving.to : search.id;
	const selected = openId
		? reports.find((report) => report.id === openId)
		: (reports.find((report) => report.id === lastRead) ?? reports[0]);
	const filtered = Boolean(search.kind || search.q.trim());

	// Two panes always show a report. It's pinned in the URL so one arriving
	// later doesn't swap it out from under a decision.
	const shownId = selected?.id;
	useEffect(() => {
		if (!search.id && shownId && !stale && window.matchMedia(WIDE).matches)
			go({ id: shownId }, true);
	}, [go, search.id, shownId, stale]);

	const [draft, setDraft] = useState(search.q);
	const searchInput = useRef<HTMLInputElement>(null);
	const [searched, setSearched] = useState(search.q);
	if (search.q !== searched) {
		setSearched(search.q);
		setDraft(search.q);
	}
	// Searches as typing pauses. Started by the typing, not by a change in the
	// URL: leaving this page changes that too, and must not bring anyone back.
	const typing = useRef<ReturnType<typeof setTimeout>>(undefined);
	useEffect(() => () => clearTimeout(typing.current), []);
	const type = (value: string) => {
		setDraft(value);
		clearTimeout(typing.current);
		typing.current = setTimeout(
			() => go({ q: value, offset: 0, id: undefined }, true),
			200
		);
	};

	const {
		mutate: saveStatus,
		mutateAsync: saveDecision,
		isPending: saving,
	} = useMutation({
		...turretFeedbackStatusMutation(queryClient),
		mutationKey: STATUS_MUTATION,
		onSuccess: undefined,
		// Only the last of a quick run of decisions refetches, so an answer
		// read between them can't bring a decided report back.
		onSettled: () => {
			if (queryClient.isMutating({ mutationKey: STATUS_MUTATION }) === 1)
				void queryClient.invalidateQueries({
					queryKey: turretKeys.feedback,
				});
		},
	});
	const issue = useMutation(turretFeedbackIssueMutation(queryClient));
	const deciding = issue.isPending || saving;

	// A link to a report in another status opens it there. A report that left
	// this view because of a decision being saved here isn't that.
	const located = useQuery({
		...turretFeedbackQueryOptions({
			id: search.id,
			from: 0,
			limit: 1,
			offset: 0,
		}),
		enabled:
			Boolean(search.id) &&
			query.isSuccess &&
			!stale &&
			!selected &&
			!deciding,
	});
	const found = located.data?.feedback[0];
	useEffect(() => {
		if (found && found.id === search.id && found.status !== search.status)
			go(
				{ status: found.status, kind: undefined, q: "", offset: 0 },
				true
			);
	}, [found, go, search.id, search.status]);
	const [done, setDone] = useState<Decided | null>(null);
	const [failure, setFailure] = useState<{
		id: string;
		message: string;
	}>();
	const [toastHeld, setToastHeld] = useState(false);
	const [issued, setIssued] = useState<
		(Decided & { fingerprint: string }) | null
	>(null);
	if (!done && !issued && toastHeld) setToastHeld(false);
	useEffect(() => {
		if ((!done && !issued) || toastHeld) return;
		const timer = setTimeout(() => {
			setDone(null);
			setIssued(null);
		}, 8000);
		return () => clearTimeout(timer);
	}, [done, issued, toastHeld]);

	// A decision as the list shows it: the report leaves this status and
	// counts toward the next, or comes back to where it was.
	const remove = useCallback(
		(report: Report, to: Status) =>
			queryClient.setQueryData(listKey, (old) =>
				old
					? {
							...old,
							feedback: old.feedback.filter(
								({ id }) => id !== report.id
							),
							counts: {
								...old.counts,
								[report.status]: old.counts[report.status] - 1,
								[to]: old.counts[to] + 1,
							},
						}
					: old
			),
		[listKey, queryClient]
	);
	const restore = useCallback(
		(report: Report, from: Status, index: number, key: ListKey) =>
			queryClient.setQueryData(key, (old) =>
				old
					? {
							...old,
							feedback: [
								...old.feedback.slice(0, index),
								report,
								...old.feedback.slice(index),
							],
							counts: {
								...old.counts,
								[from]: old.counts[from] - 1,
								[report.status]: old.counts[report.status] + 1,
							},
						}
					: old
			),
		[queryClient]
	);

	// Where focus was when a report left the view, so it lands on what replaces
	// it instead of falling back to the top of the page.
	const refocus = useRef<"list" | "reader" | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const article = useRef<HTMLElement>(null);
	const listRef = useRef<HTMLUListElement>(null);
	const reader = useRef<HTMLDivElement>(null);

	const focusOrigin = useCallback(() => {
		if (listRef.current?.contains(document.activeElement)) return "list";
		if (article.current?.contains(document.activeElement)) return "reader";
		return null;
	}, []);

	const decide = useCallback(
		(report: Report, to: Status) => {
			if (stale || report.status === to) return;
			const index = reports.findIndex(({ id }) => id === report.id);
			if (index < 0) return;
			const next = reports[index + 1] ?? reports[index - 1];
			refocus.current = focusOrigin();
			setFailure(undefined);
			void queryClient.cancelQueries({ queryKey: listKey });
			remove(report, to);
			setIssued(null);
			setDone({ report, index, to, search, key: listKey });
			setMoving({ from: report.id, to: next?.id });
			go({ id: next?.id }, true);
			// A promise, because a callback passed to mutate only runs for the
			// latest call, and any decision in a quick run can be the one to fail.
			saveDecision({ id: report.id, status: to }).catch(
				(error: Error) => {
					restore(report, to, index, listKey);
					setMoving(null);
					setDone(null);
					setFailure({ id: report.id, message: error.message });
					go({ id: report.id }, true);
				}
			);
		},
		[
			focusOrigin,
			go,
			listKey,
			queryClient,
			remove,
			reports,
			restore,
			saveDecision,
			search,
			stale,
		]
	);

	const undo = useCallback(() => {
		if (!done) return;
		const { report, index, to, key } = done;
		refocus.current = "reader";
		setMoving(null);
		setDone(null);
		setFailure(undefined);
		void queryClient.cancelQueries({ queryKey: key });
		restore(report, to, index, key);
		void navigate({
			to: INBOX,
			search: { ...done.search, id: report.id },
			replace: true,
		});
		saveStatus(
			{ id: report.id, status: report.status },
			{
				onError: (error) =>
					setFailure({ id: report.id, message: error.message }),
			}
		);
	}, [done, navigate, queryClient, restore, saveStatus]);

	const createIssueRef = useRef(createIssue);
	useEffect(() => {
		createIssueRef.current = createIssue;
	});
	// Making an issue triages the report, so it leaves New and the next opens,
	// with the issue a click away and the same undo as any decision.
	function createIssue(report: Report) {
		const index = reports.findIndex(({ id }) => id === report.id);
		const next = reports[index + 1] ?? reports[index - 1];
		const leaves = report.status === "open";
		setDone(null);
		setIssued(null);
		if (leaves) {
			refocus.current = focusOrigin();
			setMoving({ from: report.id, to: next?.id });
		}
		issue.mutate(
			{ action: "promote", feedbackId: report.id },
			{
				onSuccess: ({ issueFingerprint }) => {
					if (!issueFingerprint) return;
					setDone(null);
					setIssued({
						fingerprint: issueFingerprint,
						report,
						index,
						to: leaves ? "triaged" : report.status,
						search,
						key: listKey,
					});
					if (leaves) go({ id: next?.id }, true);
				},
				onError: () => {
					refocus.current = null;
					setMoving(null);
				},
			}
		);
	}

	// Takes the issue back, which ends it if this report was all it had.
	function undoIssue() {
		if (!issued) return;
		const { report, index, to, key } = issued;
		const left = report.status !== to;
		setIssued(null);
		setMoving(null);
		// The toast with focus is going, and if the report isn't coming back from
		// elsewhere, nothing else will move focus.
		if (left) refocus.current = "reader";
		else focusReader();
		// A failed undo leaves the report as it was, so it opens there, saying so.
		const failed = (error: Error) => {
			setFailure({
				id: report.id,
				message: `Couldn't undo: ${error.message}`,
			});
			void navigate({
				to: INBOX,
				search: { ...issued.search, status: to, id: report.id },
				replace: true,
			});
		};
		issue.mutate(
			{ action: "unlink", feedbackId: report.id },
			{
				onError: failed,
				onSuccess: () => {
					if (!left) return;
					void queryClient.cancelQueries({ queryKey: key });
					restore(report, to, index, key);
					void navigate({
						to: INBOX,
						search: { ...issued.search, id: report.id },
						replace: true,
					});
					saveStatus(
						{ id: report.id, status: report.status },
						{ onError: failed }
					);
				},
			}
		);
	}
	const undoRef = useRef(undo);
	useEffect(() => {
		undoRef.current = issued ? undoIssue : undo;
	});

	const row = (id: string) =>
		listRef.current?.querySelector<HTMLElement>(
			`[data-report="${CSS.escape(id)}"]`
		);
	const selectedId = selected?.id;
	// The selected row already shows where a shortcut landed, so the reader
	// skips its focus ring until focus leaves and comes back by Tab.
	const focusReader = () => {
		const element = reader.current;
		if (!element) return;
		element.dataset.quiet = "";
		element.focus({ preventScroll: true });
		element.addEventListener("blur", () => delete element.dataset.quiet, {
			once: true,
		});
	};
	// Where each report was left, so coming back to one finds the same place.
	const readTo = useRef(new Map<string, number>());
	const pageOpen = search.id;
	useLayoutEffect(() => {
		if (!selectedId) return;
		const top = readTo.current.get(selectedId) ?? 0;
		if (window.matchMedia(WIDE).matches) {
			if (reader.current) reader.current.scrollTop = top;
		} else if (pageOpen) window.scrollTo(0, top);
	}, [pageOpen, selectedId]);
	// Below the two-pane layout the page itself scrolls as a report is read.
	useEffect(() => {
		if (!pageOpen) return;
		const save = () => {
			if (!window.matchMedia(WIDE).matches)
				readTo.current.set(pageOpen, window.scrollY);
		};
		window.addEventListener("scroll", save, { passive: true });
		return () => window.removeEventListener("scroll", save);
	}, [pageOpen]);
	useEffect(() => {
		if (selectedId) row(selectedId)?.scrollIntoView({ block: "nearest" });
		const from = refocus.current;
		refocus.current = null;
		if (!from) return;
		if (!selectedId) heading.current?.focus({ preventScroll: true });
		else if (from === "list")
			row(selectedId)?.focus({ preventScroll: true });
		else focusReader();
	}, [selectedId]);

	// Where J and K move from: ahead of the URL, which updates a moment after
	// each press, so a held key keeps moving.
	const cursor = useRef(selectedId);
	useEffect(() => {
		cursor.current = selectedId;
	}, [selectedId]);
	const move = useCallback(
		(by: number) => {
			const index = reports.findIndex(({ id }) => id === cursor.current);
			const next = reports[index + by];
			if (!next) return null;
			cursor.current = next.id;
			setFailure(undefined);
			go({ id: next.id }, true);
			return next.id;
		},
		[go, reports]
	);

	const issuing = issue.isPending;
	const [shortcuts, setShortcuts] = useState(readShortcuts);
	const [help, setHelp] = useState(false);
	useEffect(() => {
		if (!shortcuts) return;
		const onKey = (event: KeyboardEvent) => {
			// Shortcuts are for the two-pane layout, which shows them and the
			// switch that turns them off. Below it, keys mean what they usually do.
			if (
				!window.matchMedia(WIDE).matches ||
				event.metaKey ||
				event.ctrlKey ||
				event.altKey ||
				event.defaultPrevented
			)
				return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
					(event.key !== "?" &&
						target.closest("[role=listbox],[role=dialog]")))
			)
				return;
			const current = stale || issuing ? undefined : selected;
			// Focus goes with the report, so Tab and arrows work from there.
			const step = (by: number) => {
				refocus.current = "reader";
				if (!move(by)) refocus.current = null;
			};
			const actions: Record<string, () => void> = {
				"/": () => searchInput.current?.focus(),
				"?": () => setHelp((open) => !open),
				j: () => step(1),
				k: () => step(-1),
				t: () =>
					current?.status === "open" && decide(current, "triaged"),
				e: () =>
					current &&
					current.status !== "resolved" &&
					decide(current, "resolved"),
				n: () =>
					current &&
					current.status !== "open" &&
					decide(current, "open"),
				i: () =>
					current &&
					!current.issueFingerprint &&
					createIssueRef.current(current),
				z: () => undoRef.current(),
			};
			// With nothing focused, arrows read on through the open report.
			if (
				target === document.body &&
				(event.key === "ArrowDown" || event.key === "ArrowUp")
			) {
				reader.current?.scrollBy({
					top: event.key === "ArrowDown" ? 96 : -96,
				});
				return;
			}
			// Caps Lock shouldn't turn shortcuts off.
			const key =
				event.key.length === 1 ? event.key.toLowerCase() : event.key;
			// A held J or K keeps moving. A held decision would run on through
			// the reports after this one, past what undo can take back.
			if (event.repeat && key !== "j" && key !== "k") return;
			const action = actions[key];
			if (!action) return;
			event.preventDefault();
			action();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [decide, issuing, move, selected, shortcuts, stale]);

	const reading = Boolean(search.id);
	const matchesElsewhere = turretFeedbackStatusSchema.options.find(
		(status) => status !== search.status && counts?.[status]
	);
	const selectedIndex = selected ? reports.indexOf(selected) : -1;

	// A phone shows the list or a report, so focus crosses with the view, and
	// coming back finds the report just read.
	const wasReading = useRef(reading);
	useEffect(() => {
		if (wasReading.current === reading) return;
		wasReading.current = reading;
		if (window.matchMedia(WIDE).matches) return;
		if (reading) reader.current?.focus({ preventScroll: true });
		else if (lastRead) {
			const back = row(lastRead);
			back?.scrollIntoView({ block: "center" });
			back?.focus({ preventScroll: true });
		}
	}, [lastRead, reading]);

	// Deciding the last rows of a later page leaves nothing to show there.
	const emptied = !reports.length && !stale && query.isSuccess;
	useEffect(() => {
		if (emptied && search.offset > 0)
			go({ offset: Math.max(0, search.offset - PAGE_SIZE) }, true);
	}, [emptied, go, search.offset]);

	// On wide screens the panes fill what's left of the window and scroll on
	// their own, whatever notices sit above them.
	const panes = useRef<HTMLDivElement>(null);
	useLayoutEffect(() => {
		const element = panes.current;
		if (!element) return;
		const fit = () =>
			element.style.setProperty(
				"--panes-height",
				`${Math.max(480, window.innerHeight - element.getBoundingClientRect().top - window.scrollY - 16)}px`
			);
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	});

	return (
		<section className="space-y-4">
			<div
				className={cn(
					"flex flex-wrap items-end gap-x-6 gap-y-3 lg:border-b",
					reading && "hidden lg:flex"
				)}
			>
				<h1
					ref={heading}
					tabIndex={-1}
					className="text-2xl font-semibold tracking-tight outline-none max-lg:sr-only lg:pb-2"
				>
					Feedback
				</h1>
				<nav
					aria-label="Status"
					className="flex w-full gap-1 border-b text-sm lg:-mb-px lg:w-auto lg:border-b-0"
				>
					{turretFeedbackStatusSchema.options.map((status) => {
						const current = search.status === status;
						return (
							<Link
								key={status}
								to={INBOX}
								search={{
									...search,
									status,
									offset: 0,
									id: undefined,
								}}
								aria-current={current ? "page" : undefined}
								className={cn(
									tabLinkClass,
									"-mb-px gap-2 px-3",
									current && tabActiveProps.className
								)}
							>
								{statusLabels[status]}
								<span
									className={cn(
										"inline-flex h-5 min-w-6 items-center justify-center rounded-full px-1.5 text-xs font-medium tabular-nums",
										status === "open" && counts?.open
											? toneClasses.pill.waiting
											: toneClasses.pill.neutral,
										!counts && "invisible"
									)}
								>
									{counts?.[status]}
								</span>
							</Link>
						);
					})}
				</nav>
				<div className="flex w-full min-w-0 items-center gap-2 lg:mb-1 lg:ml-auto lg:w-auto">
					<div className="relative min-w-0 flex-1 lg:w-64 lg:flex-none">
						<Search
							aria-hidden
							className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
						/>
						<Input
							ref={searchInput}
							type="search"
							aria-label="Search by message, person or page"
							placeholder="Search feedback"
							value={draft}
							onChange={(event) => type(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape")
									event.currentTarget.blur();
							}}
							className="h-11 pl-9 lg:h-9"
						/>
					</div>
					<Select
						value={search.kind ?? "all"}
						onValueChange={(value) => {
							const kind =
								turretFeedbackKindSchema.safeParse(value);
							go({
								kind: kind.success ? kind.data : undefined,
								offset: 0,
								id: undefined,
							});
						}}
					>
						<SelectTrigger
							aria-label="Kind"
							className="h-11! w-32 shrink-0 lg:h-9!"
						>
							<SelectValue>
								{(value: string) => {
									const kind =
										turretFeedbackKindSchema.safeParse(
											value
										);
									return kind.success
										? kinds[kind.data].label
										: "All kinds";
								}}
							</SelectValue>
						</SelectTrigger>
						<SelectContent>
							<SelectItem value="all">All kinds</SelectItem>
							{turretFeedbackKindSchema.options.map((kind) => (
								<SelectItem key={kind} value={kind}>
									{kinds[kind].label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			</div>

			{query.isPending ? (
				<div
					ref={panes}
					role="status"
					aria-busy
					aria-label="Loading feedback"
					className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:h-(--panes-height) lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]"
				>
					<div className="space-y-2">
						{Array.from({ length: 5 }, (_, index) => (
							<div key={index} className="flex gap-3 p-3">
								<Skeleton className="size-8 shrink-0 rounded-full" />
								<div className="flex-1 space-y-2">
									<Skeleton className="h-4 w-3/4" />
									<Skeleton className="h-4 w-full" />
									<Skeleton className="h-3 w-1/2" />
								</div>
							</div>
						))}
					</div>
					<div className="hidden flex-col rounded-xl border bg-card lg:flex">
						<div className="space-y-3 border-b px-6 pt-5 pb-4">
							<div className="flex gap-3">
								<Skeleton className="size-10 shrink-0 rounded-full" />
								<div className="flex-1 space-y-2">
									<Skeleton className="h-4 w-48" />
									<Skeleton className="h-4 w-64" />
								</div>
							</div>
							<Skeleton className="h-8 w-72" />
						</div>
						<div className="flex-1 space-y-3 p-6">
							<Skeleton className="h-4 w-full max-w-prose" />
							<Skeleton className="h-4 w-full max-w-prose" />
							<Skeleton className="h-4 w-2/3 max-w-prose" />
						</div>
						<div className="flex gap-2 border-t px-6 py-3">
							<Skeleton className="h-9 w-32 rounded-full" />
							<Skeleton className="h-9 w-24 rounded-full" />
						</div>
					</div>
				</div>
			) : query.isError && !query.data ? (
				<InboxMessage
					alert
					icon={RotateCcw}
					title="Couldn't load feedback."
					action={
						<Button
							variant="outline"
							onClick={() => void query.refetch()}
						>
							Try again
						</Button>
					}
				/>
			) : !reports.length && !search.id ? (
				filtered ? (
					<InboxMessage
						icon={FolderSearch}
						title={`No ${statusLabels[search.status].toLowerCase()} feedback matches.`}
						detail={
							matchesElsewhere
								? `${plural(counts?.[matchesElsewhere] ?? 0, "match")} in ${statusLabels[matchesElsewhere]}.`
								: "Try other words, or clear the filters."
						}
						action={
							matchesElsewhere ? (
								<Button
									variant="outline"
									onClick={() =>
										go({
											status: matchesElsewhere,
											offset: 0,
										})
									}
								>
									Look in {statusLabels[matchesElsewhere]}
								</Button>
							) : (
								<Button
									variant="outline"
									onClick={() =>
										go({
											kind: undefined,
											q: "",
											offset: 0,
										})
									}
								>
									Clear filters
								</Button>
							)
						}
					/>
				) : (
					<InboxMessage
						icon={
							search.status === "open"
								? CheckCheck
								: MessageSquare
						}
						title={
							search.status === "open"
								? "No new feedback."
								: `No ${statusLabels[search.status].toLowerCase()} feedback.`
						}
						detail={
							search.status === "open"
								? "New reports show up here."
								: search.status === "triaged"
									? "Reports you triage show up here."
									: "Reports you resolve show up here."
						}
					/>
				)
			) : (
				<div
					ref={panes}
					className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:h-(--panes-height) lg:grid-cols-[minmax(20rem,24rem)_minmax(0,1fr)]"
				>
					<div
						aria-busy={stale}
						className={cn(
							"flex min-h-0 flex-col transition-opacity",
							reading && "hidden lg:flex",
							stale && "opacity-50"
						)}
					>
						{query.isError && (
							<p
								role="status"
								className="px-3 pb-2 text-xs text-muted-foreground"
							>
								Couldn't refresh. This is the last list loaded.
							</p>
						)}
						<ul
							ref={listRef}
							aria-label={`${statusLabels[search.status]} feedback`}
							onKeyDown={(event) => {
								if (
									event.key !== "ArrowDown" &&
									event.key !== "ArrowUp"
								)
									return;
								event.preventDefault();
								// From the row with focus, which Tab can put
								// anywhere, not the report that's open.
								if (
									event.target instanceof HTMLElement &&
									event.target.dataset.report
								)
									cursor.current =
										event.target.dataset.report;
								const id = move(
									event.key === "ArrowDown" ? 1 : -1
								);
								if (id) row(id)?.focus();
							}}
							className="-mx-1 -my-0.5 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1 py-0.5"
						>
							{reports.map((report) => (
								<li key={report.id}>
									<ReportRow
										report={report}
										selected={report.id === selectedId}
										marked={report.id === lastRead}
										search={search}
									/>
								</li>
							))}
						</ul>
						<div className="pt-2 empty:hidden">
							<Pagination
								page={
									counts && {
										offset: search.offset,
										total: counts[search.status],
									}
								}
								onPage={(offset) =>
									go({ offset, id: undefined })
								}
							/>
						</div>
					</div>
					<div
						className={cn(
							"min-h-0 min-w-0",
							!reading && "hidden lg:block"
						)}
					>
						{selected ? (
							<ReportPane
								key={selected.id}
								ref={article}
								readerRef={reader}
								position={{
									at: selectedIndex + 1 + search.offset,
									of:
										counts?.[search.status] ??
										reports.length,
									previous: reports[selectedIndex - 1]?.id,
									next: reports[selectedIndex + 1]?.id,
								}}
								onNeighbor={() => {
									refocus.current = "reader";
								}}
								onRead={(top) =>
									readTo.current.set(selected.id, top)
								}
								report={selected}
								search={search}
								busy={issue.isPending || stale}
								error={
									(failure?.id === selected.id
										? failure.message
										: undefined) ??
									(issue.variables?.feedbackId === selected.id
										? issue.error?.message
										: undefined)
								}
								hints={shortcuts}
								help={
									<ShortcutsHelp
										open={help}
										onOpenChange={setHelp}
										enabled={shortcuts}
										onEnabledChange={(enabled) => {
											setShortcuts(enabled);
											writeShortcuts(enabled);
										}}
									/>
								}
								onDecide={decide}
								onCreateIssue={createIssue}
							/>
						) : (
							<NotInView
								search={search}
								decided={Boolean(done)}
								looking={located.isFetching}
							/>
						)}
					</div>
				</div>
			)}

			<p aria-live="polite" className="sr-only">
				{counts && !stale
					? plural(
							counts[search.status],
							`${statusLabels[search.status].toLowerCase()} report`
						)
					: ""}
			</p>
			<div
				aria-live="polite"
				onMouseEnter={() => setToastHeld(true)}
				onMouseLeave={() => setToastHeld(false)}
				onFocus={() => setToastHeld(true)}
				onBlur={() => setToastHeld(false)}
				className="pointer-events-none fixed inset-x-0 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-40 mx-auto flex max-w-7xl justify-center px-4 lg:pl-[calc(24rem+2rem)]"
			>
				{issue.isPending && issue.variables.action === "promote" && (
					<div className="pointer-events-auto rounded-full border bg-popover px-4 py-2.5 text-sm shadow-lg">
						Creating issue…
					</div>
				)}
				{issued && !done && (
					<div className="pointer-events-auto flex max-w-full items-center gap-1 rounded-3xl border bg-popover py-1 pr-1 pl-3 text-sm shadow-lg sm:gap-2 sm:pl-4">
						<CircleCheck
							aria-hidden
							className="size-4 shrink-0 text-tone-done-foreground"
						/>
						<span className="min-w-0 leading-tight sm:whitespace-nowrap">
							Issue created
							{issued.report.status !== issued.to && (
								<span className="block sm:inline">
									<span className="max-sm:hidden"> · </span>
									<span className="sr-only sm:not-sr-only">
										Moved to{" "}
									</span>
									{statusLabels[issued.to]}
								</span>
							)}
						</span>
						<Link
							to="/ts_admin/turret/issues/$fingerprint"
							params={{ fingerprint: issued.fingerprint }}
							search={{ report: issued.report.id }}
							className={buttonVariants({
								variant: "ghost",
								size: "sm",
								className: "h-11 shrink-0 max-sm:px-2 lg:h-8",
							})}
							aria-label="View issue"
						>
							<span className="sm:hidden">View</span>
							<span className="hidden sm:inline">View issue</span>
						</Link>
						<Button
							size="sm"
							variant="ghost"
							onClick={undoIssue}
							className="h-11 shrink-0 max-sm:px-2 lg:h-8"
						>
							Undo
							{shortcuts && (
								<Key className="ml-1 hidden bg-tone-neutral text-tone-neutral-foreground lg:inline-flex">
									Z
								</Key>
							)}
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Dismiss"
							onClick={() => {
								setIssued(null);
								focusReader();
							}}
							className="size-11 shrink-0 lg:size-8"
						>
							<X aria-hidden className="size-4" />
						</Button>
					</div>
				)}
				{done && (
					<div className="pointer-events-auto flex items-center gap-2 rounded-full border bg-popover py-1 pr-1 pl-4 text-sm shadow-lg">
						<CircleCheck
							aria-hidden
							className="size-4 shrink-0 text-tone-done-foreground"
						/>
						<span className="whitespace-nowrap">
							Moved to {statusLabels[done.to]}
						</span>
						<Button
							size="sm"
							variant="ghost"
							onClick={undo}
							className="h-11 lg:h-8"
						>
							Undo
							{shortcuts && (
								<Key className="ml-1 hidden bg-tone-neutral text-tone-neutral-foreground lg:inline-flex">
									Z
								</Key>
							)}
						</Button>
						<Button
							size="icon-sm"
							variant="ghost"
							aria-label="Dismiss"
							onClick={() => {
								setDone(null);
								focusReader();
							}}
							className="size-11 lg:size-8"
						>
							<X aria-hidden className="size-4" />
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}

function readShortcuts() {
	try {
		return window.localStorage.getItem(SHORTCUTS_KEY) !== "off";
	} catch {
		return true;
	}
}
function writeShortcuts(enabled: boolean) {
	try {
		window.localStorage.setItem(SHORTCUTS_KEY, enabled ? "on" : "off");
	} catch {
		// Remembered for this visit only.
	}
}

function ReportRow({
	report,
	selected,
	marked,
	search,
}: {
	report: Report;
	selected: boolean;
	// Read last, and so marked at every width. A report selected only because
	// it's first shows in the pane beside the list, so only wide screens mark it.
	marked: boolean;
	search: InboxSearch;
}) {
	const { headline, preview } = reportSummary(report.message);
	const area = reportArea(report.url);
	const reporter = reporterOf(report);
	// Muted text on the selected row's muted surface would fall below 4.5:1.
	const quiet = cn(
		"text-muted-foreground",
		selected && "lg:text-foreground/75",
		marked && "text-foreground/75"
	);
	return (
		<Link
			to={INBOX}
			search={{ ...search, id: report.id }}
			replace={Boolean(search.id)}
			resetScroll={false}
			data-report={report.id}
			aria-current={selected ? "true" : undefined}
			className={cn(
				"flex gap-3 rounded-lg border border-transparent p-3 transition-colors outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring",
				selected && "lg:border-border lg:bg-muted",
				marked && "border-border bg-muted"
			)}
		>
			<KindIcon kind={report.kind} onMuted={selected || marked} />
			<span className="min-w-0 flex-1">
				<span className="line-clamp-2 text-sm font-medium">
					{headline}
				</span>
				{preview && (
					<span className={cn("mt-0.5 line-clamp-2 text-sm", quiet)}>
						{preview}
					</span>
				)}
				<span
					className={cn(
						"mt-1 flex min-w-0 items-center gap-1.5 text-xs",
						quiet
					)}
				>
					<span className="truncate" title={reporter}>
						{reporterName(reporter)}
					</span>
					{area && (
						<>
							<span aria-hidden>·</span>
							<span className="shrink-0">{area}</span>
						</>
					)}
					<span aria-hidden>·</span>
					<time
						className="shrink-0 tabular-nums"
						dateTime={new Date(report.ts).toISOString()}
					>
						{formatAgo(report.ts)}
					</time>
					{report.issueFingerprint && (
						<span className="flex shrink-0 items-center gap-1.5">
							<span aria-hidden>·</span>
							<Link2 aria-hidden className="ml-0.5 size-3" />
							Issue
						</span>
					)}
				</span>
			</span>
		</Link>
	);
}

function Key({ className, ...props }: ComponentProps<typeof Kbd>) {
	return (
		<Kbd aria-hidden className={cn("font-mono", className)} {...props} />
	);
}

// An address that breaks after its @ when it has to, not mid-word.
function Address({ value }: { value: string }) {
	const at = value.indexOf("@");
	if (at < 0) return value;
	return (
		<>
			{value.slice(0, at)}
			<wbr />
			{value.slice(at)}
		</>
	);
}

// The report before or after this one, on a phone where the list isn't beside
// it. Unavailable at either end, but still there, so the buttons don't shift.
function Neighbor({
	label,
	icon: Icon,
	search,
	id,
	onOpen,
}: {
	label: string;
	icon: LucideIcon;
	search: InboxSearch;
	id?: string;
	onOpen: () => void;
}) {
	if (!id)
		return (
			<span
				aria-hidden
				className="flex size-11 items-center justify-center text-muted-foreground/40"
			>
				<Icon className="size-5" />
			</span>
		);
	return (
		<Link
			to={INBOX}
			search={{ ...search, id }}
			replace
			resetScroll={false}
			aria-label={label}
			onClick={onOpen}
			className={cn(
				"flex size-11 items-center justify-center hover:bg-muted",
				focusRing
			)}
		>
			<Icon aria-hidden className="size-5" />
		</Link>
	);
}

function KindIcon({ kind, onMuted }: { kind: Kind; onMuted: boolean }) {
	const { label, icon: Icon, tone } = kinds[kind];
	return (
		<span
			title={label}
			className={cn(
				"flex size-8 shrink-0 items-center justify-center rounded-full",
				toneClasses.pill[tone],
				// The neutral circle would vanish into a selected row.
				onMuted && tone === "neutral" && "bg-background"
			)}
		>
			<Icon aria-hidden className="size-4" />
			<span className="sr-only">{label}</span>
		</span>
	);
}

function ReportPane({
	ref,
	readerRef,
	position,
	onNeighbor,
	onRead,
	report,
	search,
	busy,
	error,
	hints,
	help,
	onDecide,
	onCreateIssue,
}: {
	ref: Ref<HTMLElement>;
	readerRef: Ref<HTMLDivElement>;
	position?: {
		at: number;
		of: number;
		previous?: string;
		next?: string;
	};
	onNeighbor: () => void;
	onRead: (top: number) => void;
	report: Report;
	search: InboxSearch;
	busy: boolean;
	error?: string;
	hints: boolean;
	help: ReactNode;
	onDecide: (report: Report, to: Status) => void;
	onCreateIssue: (report: Report) => void;
}) {
	const reporter = reporterOf(report);
	const kind = kinds[report.kind];
	const KindGlyph = kind.icon;
	const page = webUrl(report.url);
	const { headline } = reportSummary(report.message);
	const contact = report.contact?.trim();
	const decision = (
		label: string,
		hint: string,
		to: Status,
		primary = false
	) => (
		<Button
			variant={primary ? "default" : "outline"}
			disabled={busy}
			onClick={() => onDecide(report, to)}
			aria-keyshortcuts={hints ? hint.toLowerCase() : undefined}
			className="h-11 max-[359px]:px-2 lg:h-9"
		>
			{label}
			{hints && (
				<Key
					className={cn(
						"ml-1 hidden lg:inline-flex",
						primary
							? "bg-primary-foreground/15 text-primary-foreground"
							: "bg-background text-foreground"
					)}
				>
					{hint}
				</Key>
			)}
		</Button>
	);
	return (
		<article
			ref={ref}
			aria-label={`Feedback from ${reporter}`}
			data-reading={search.id ? "" : undefined}
			className="-mx-4 -mt-2 flex min-h-0 flex-col pb-24 lg:mx-0 lg:mt-0 lg:h-full lg:rounded-xl lg:border lg:bg-card lg:pb-0"
		>
			<div className="sticky top-0 z-20 flex min-h-11 items-center justify-between gap-3 border-b bg-background px-4 lg:hidden">
				<Link
					to={INBOX}
					search={{ ...search, id: undefined }}
					resetScroll={false}
					className={cn(
						"flex min-h-11 shrink-0 items-center gap-1 text-sm text-muted-foreground hover:text-foreground",
						focusRing
					)}
				>
					<ArrowLeft aria-hidden className="size-4" />
					Back to {statusLabels[search.status]}
				</Link>
				{position && (
					<div className="flex items-center gap-1">
						<span className="text-sm text-muted-foreground tabular-nums">
							{position.at} of {position.of}
						</span>
						<Neighbor
							label="Previous report"
							icon={ChevronUp}
							search={search}
							id={position.previous}
							onOpen={onNeighbor}
						/>
						<Neighbor
							label="Next report"
							icon={ChevronDown}
							search={search}
							id={position.next}
							onOpen={onNeighbor}
						/>
					</div>
				)}
			</div>
			<header className="space-y-3 border-b px-4 py-4 lg:px-6 lg:pt-5">
				<h2 className="sr-only">{headline}</h2>
				<div className="flex items-start gap-3">
					<span
						aria-hidden
						className="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-semibold"
					>
						{reporterInitials(reporter)}
					</span>
					<div className="min-w-0 flex-1">
						<span className="font-medium wrap-anywhere">
							<Address value={reporter} />
						</span>
						<div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
							<time dateTime={new Date(report.ts).toISOString()}>
								{formatDateTime(report.ts)}
							</time>
							{contact && contact !== report.userEmail && (
								<span className="wrap-anywhere">
									Contact: {contact}
								</span>
							)}
							<span className="flex items-center gap-1">
								<KindGlyph
									aria-hidden
									className={cn(
										"size-4",
										toneClasses.text[kind.tone]
									)}
								/>
								{kind.label}
							</span>
							<StatusPill tone={statusTones[report.status]}>
								{statusLabels[report.status]}
							</StatusPill>
							{report.status !== "open" && (
								<span>
									Updated{" "}
									{formatAgo(report.updatedAt).replace(
										"Yesterday",
										"yesterday"
									)}
								</span>
							)}
						</div>
					</div>
				</div>
				<div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
					{report.userEmail && (
						<a
							href={`mailto:${report.userEmail}?subject=${encodeURIComponent(`Your ${appName} feedback`)}`}
							className={cn(
								"inline-flex min-h-11 items-center gap-1.5 hover:text-foreground hover:underline lg:min-h-8",
								focusRing
							)}
						>
							<Mail aria-hidden className="size-4" />
							<span>
								Reply
								<span className="max-sm:sr-only">
									{" "}
									by email
								</span>
							</span>
						</a>
					)}
					{page && (
						<a
							href={page.toString()}
							target="_blank"
							rel="noreferrer noopener"
							className={cn(
								"inline-flex min-h-11 items-center gap-1.5 hover:text-foreground hover:underline lg:min-h-8",
								focusRing
							)}
						>
							<ExternalLink aria-hidden className="size-4" />
							<span>
								<span className="max-sm:sr-only">
									Sent from{" "}
								</span>
								{reportArea(report.url)}
								<span className="sr-only">
									{" "}
									(opens in a new tab)
								</span>
							</span>
							<span
								title={reportPath(report.url) ?? undefined}
								className="hidden max-w-72 truncate text-xs md:inline"
							>
								{reportPath(report.url)}
							</span>
						</a>
					)}
					{report.replayAvailable && (
						<Link
							to="/ts_admin/turret/replay-sessions/$sessionId"
							params={{ sessionId: report.sessionId }}
							search={{
								t: Math.max(0, report.ts - REPLAY_LEAD_MS),
							}}
							className={cn(
								"inline-flex min-h-11 items-center gap-1.5 hover:text-foreground hover:underline lg:min-h-8",
								focusRing
							)}
						>
							<PlayCircle aria-hidden className="size-4" />
							<span>
								<span className="max-sm:sr-only">
									Watch the{" "}
								</span>
								<span className="max-sm:capitalize">
									session
								</span>
							</span>
						</Link>
					)}
					{report.issueFingerprint && (
						<Link
							to="/ts_admin/turret/issues/$fingerprint"
							params={{ fingerprint: report.issueFingerprint }}
							search={{ report: report.id }}
							className={cn(
								"inline-flex min-h-11 items-center gap-1.5 hover:text-foreground hover:underline lg:min-h-8",
								focusRing
							)}
						>
							<Link2 aria-hidden className="size-4" />
							View issue
						</Link>
					)}
				</div>
			</header>

			<div
				ref={readerRef}
				tabIndex={0}
				role="region"
				aria-label={`Message from ${reporterName(reporter)}: ${headline}`}
				onScroll={(event) => onRead(event.currentTarget.scrollTop)}
				className="min-h-0 flex-1 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-quiet:ring-0 lg:px-6 lg:pt-6 lg:pb-16"
			>
				<Message text={report.message} />
			</div>

			<footer
				data-bottom-bar
				className="fixed inset-x-0 bottom-0 z-30 space-y-2 border-t bg-card px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:static lg:rounded-b-xl lg:px-6"
			>
				{error && (
					<p role="alert" className="text-sm text-destructive">
						{error}
					</p>
				)}
				<div className="flex items-center gap-1 min-[360px]:gap-2">
					{report.status === "open" && (
						<>
							{decision("Mark triaged", "T", "triaged", true)}
							{decision("Resolve", "E", "resolved")}
						</>
					)}
					{report.status === "triaged" && (
						<>
							{decision("Resolve", "E", "resolved", true)}
							{decision("Move to New", "N", "open")}
						</>
					)}
					{report.status === "resolved" &&
						decision("Reopen", "N", "open")}
					{!report.issueFingerprint && (
						<Button
							variant="ghost"
							disabled={busy}
							onClick={() => onCreateIssue(report)}
							aria-keyshortcuts={hints ? "i" : undefined}
							className="h-11 max-[359px]:px-2 lg:h-9"
						>
							Create issue
							{hints && (
								<Key className="ml-1 hidden bg-tone-neutral text-tone-neutral-foreground lg:inline-flex">
									I
								</Key>
							)}
						</Button>
					)}
					<div className="-mr-2.5 ml-auto hidden lg:block">
						{help}
					</div>
				</div>
			</footer>
		</article>
	);
}

const shortcutList = [
	["J / K", "Next or previous report"],
	["T", "Mark triaged"],
	["E", "Resolve"],
	["N", "Move to New or reopen"],
	["I", "Create issue"],
	["Z", "Undo"],
	["/", "Search"],
	["?", "Show this list"],
] as const;

function ShortcutsHelp({
	open,
	onOpenChange,
	enabled,
	onEnabledChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	enabled: boolean;
	onEnabledChange: (enabled: boolean) => void;
}) {
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<PopoverTrigger
				render={
					<Button variant="ghost" size="sm">
						<Keyboard aria-hidden className="size-4" />
						Shortcuts
					</Button>
				}
			/>
			<PopoverContent align="end" side="top" className="w-72 gap-3">
				<label className="flex items-center justify-between gap-3 text-sm font-medium">
					Keyboard shortcuts
					<Switch
						checked={enabled}
						onCheckedChange={(checked) => onEnabledChange(checked)}
					/>
				</label>
				<dl className="space-y-2 border-t pt-3 text-sm">
					{shortcutList.map(([key, label]) => (
						<div
							key={key}
							className="flex items-center justify-between gap-3"
						>
							<dt className="text-muted-foreground">{label}</dt>
							<dd>
								<Key
									aria-hidden={false}
									className="bg-tone-neutral text-tone-neutral-foreground"
								>
									{key}
								</Key>
							</dd>
						</div>
					))}
				</dl>
			</PopoverContent>
		</Popover>
	);
}

// A report as its author structured it, at a width that reads well.
function Message({ text }: { text: string }) {
	return (
		<div className="max-w-prose space-y-3 text-base leading-relaxed wrap-anywhere">
			{messageBlocks(text).map((block, index) => {
				if (block.kind === "heading")
					return (
						<h3
							key={index}
							className="pt-2 font-semibold first:pt-0"
						>
							<Linked text={block.text} />
						</h3>
					);
				if (block.kind === "list")
					return (
						<ul key={index} className="list-disc space-y-1 pl-5">
							{block.items.map((item, at) => (
								<li key={at}>
									<Linked text={item} />
								</li>
							))}
						</ul>
					);
				return (
					<p key={index} className="whitespace-pre-line">
						<Linked text={block.text} />
					</p>
				);
			})}
		</div>
	);
}

function Linked({ text }: { text: string }) {
	return linkParts(text).map((part, index) =>
		"href" in part ? (
			<a
				key={index}
				href={part.href}
				target="_blank"
				rel="noreferrer noopener"
				className={cn(
					"underline underline-offset-2 hover:text-muted-foreground",
					focusRing
				)}
			>
				{part.text}
				<span className="sr-only"> (opens in a new tab)</span>
			</a>
		) : (
			<span key={index}>{part.text}</span>
		)
	);
}

function NotInView({
	search,
	decided,
	looking,
}: {
	search: InboxSearch;
	decided: boolean;
	looking: boolean;
}) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 rounded-xl p-8 text-center lg:border text-sm text-muted-foreground">
			{looking ? (
				<p>Finding that report…</p>
			) : (
				<>
					<p>
						{decided
							? "That was the last one here."
							: "That report is no longer here."}
					</p>
					<Link
						to={INBOX}
						search={{ ...search, id: undefined }}
						className={buttonVariants({ variant: "outline" })}
					>
						Back to {statusLabels[search.status]}
					</Link>
				</>
			)}
		</div>
	);
}

function InboxMessage({
	alert = false,
	icon: Icon,
	title,
	detail,
	action,
}: {
	alert?: boolean;
	icon: LucideIcon;
	title: string;
	detail?: string;
	action?: ReactNode;
}) {
	return (
		<Empty role={alert ? "alert" : undefined}>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Icon aria-hidden />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				{detail && <EmptyDescription>{detail}</EmptyDescription>}
			</EmptyHeader>
			{action && <EmptyContent>{action}</EmptyContent>}
		</Empty>
	);
}
