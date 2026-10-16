// `pnpm shot <path...>`: signed-in screenshots of app pages, with each page's
// console errors and failed requests, so an agent can see a UI change and
// show it to a human without writing a throwaway Playwright script.

import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import {
	type BrowserContext,
	chromium,
	errors,
	type Page,
} from "@playwright/test";
import {
	type Command,
	CommandError,
	isEntryPoint,
	parseBoundedInteger,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";
import {
	asUsage,
	credentialsFor,
	type Identity,
	PAGE_BASE_PATH,
	parseIdentity,
	resolveAppPath,
	type ServerKind,
	type Session,
	signIn,
	withServer,
} from "./lib/local-app.ts";

// Screenshots are for looking at; more pages than this is a crawl.
export const SHOT_PATHS_MAX = 20;
export const SHOT_VIEWPORTS_MAX = 3;
export const SHOT_OUT_DIR_DEFAULT = path.join(".wrangler", "shots");
const VIEWPORT_PIXELS_MIN = 200;
const VIEWPORT_PIXELS_MAX = 4_096;
const NAVIGATION_TIMEOUT_MS = 30_000;
// Long enough for the SPA's queries; a page still loading after this is
// photographed as it is, with a note.
const SETTLE_TIMEOUT_MS = 10_000;
// Per page, so a page that logs in a loop cannot flood the report.
const MESSAGES_PER_PAGE_MAX = 20;
const MESSAGE_CHARACTERS_MAX = 300;

export const SHOT_USAGE = `Usage: pnpm shot <path...> [--as <who>] [--viewport <size>] [--out <dir>] [--full-page] [--e2e]

Screenshots app pages as PNGs and reports each page's HTTP status, uncaught
exceptions, console errors and failed requests. Exits 1 when a page did not
load or threw; the PNGs are still written.

  <path>       Up to ${SHOT_PATHS_MAX}. Relative paths are under ${PAGE_BASE_PATH} ("organizations" is
               ${PAGE_BASE_PATH}/organizations); a leading slash is taken as written ("/", "/docs").
  ${asUsage("             ")}
  --viewport   phone (390x844), desktop (1440x900, default) or <W>x<H>
               (${VIEWPORT_PIXELS_MIN}-${VIEWPORT_PIXELS_MAX}). Repeat for up to ${SHOT_VIEWPORTS_MAX} sizes.
  --out        Directory for the PNGs (default ${SHOT_OUT_DIR_DEFAULT}).
  --full-page  Capture the whole scrollable page, not just the viewport.
  --e2e        Start an isolated server with seeded fixture users instead of
               using this checkout's running dev server (pnpm dev).`;

export type Viewport = {
	readonly name: string;
	readonly width: number;
	readonly height: number;
	readonly mobile: boolean;
};

export type ShotTarget = {
	readonly path: string;
	readonly fileStem: string;
};

export type ShotOptions = {
	readonly targets: readonly ShotTarget[];
	readonly identity: Identity;
	readonly viewports: readonly Viewport[];
	readonly outDir: string;
	readonly fullPage: boolean;
	readonly server: ServerKind;
};

const NAMED_VIEWPORTS: readonly Viewport[] = [
	{ name: "phone", width: 390, height: 844, mobile: true },
	{ name: "desktop", width: 1440, height: 900, mobile: false },
];

export function parseShotOptions(
	argv: readonly string[]
): Command<ShotOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		as: { type: "string" },
		viewport: { type: "string", multiple: true },
		out: { type: "string" },
		"full-page": { type: "boolean" },
		e2e: { type: "boolean" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	if (positionals.length === 0)
		throw new UsageError("Give at least one path to screenshot.");
	const paths = [
		...new Set(positionals.map((p) => resolveAppPath(p, PAGE_BASE_PATH))),
	];
	if (paths.length > SHOT_PATHS_MAX)
		throw new UsageError(
			`At most ${SHOT_PATHS_MAX} paths per run, got ${paths.length}.`
		);
	const viewportValues = values.viewport ?? ["desktop"];
	if (viewportValues.length > SHOT_VIEWPORTS_MAX)
		throw new UsageError(`At most ${SHOT_VIEWPORTS_MAX} --viewport sizes.`);
	if (values.out === "") throw new UsageError("--out cannot be empty.");
	return {
		kind: "run",
		options: {
			targets: shotTargets(paths),
			identity: parseIdentity(values.as),
			viewports: viewportValues.map(parseViewport),
			outDir: values.out ?? SHOT_OUT_DIR_DEFAULT,
			fullPage: values["full-page"] === true,
			server: values.e2e === true ? "e2e" : "dev",
		},
	};
}

export function parseViewport(value: string): Viewport {
	const named = NAMED_VIEWPORTS.find((viewport) => viewport.name === value);
	if (named !== undefined) return named;
	const match = /^(\d+)x(\d+)$/.exec(value);
	if (match === null)
		throw new UsageError(
			`--viewport must be phone, desktop or <W>x<H>, got "${value}".`
		);
	const bounds = { min: VIEWPORT_PIXELS_MIN, max: VIEWPORT_PIXELS_MAX };
	const width = parseBoundedInteger(match[1] ?? "", {
		name: "--viewport width",
		...bounds,
	});
	const height = parseBoundedInteger(match[2] ?? "", {
		name: "--viewport height",
		...bounds,
	});
	return { name: `${width}x${height}`, width, height, mobile: false };
}

// One file stem per path, unique within the run: "/app/organizations" ->
// "app-organizations", "/" -> "home".
export function shotTargets(paths: readonly string[]): ShotTarget[] {
	const used = new Set<string>();
	const targets: ShotTarget[] = [];
	for (const appPath of paths) {
		const slug =
			appPath
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "") || "home";
		let fileStem = slug;
		for (let suffix = 2; used.has(fileStem); suffix += 1)
			fileStem = `${slug}-${suffix}`;
		used.add(fileStem);
		targets.push({ path: appPath, fileStem });
	}
	return targets;
}

export type PageReport = {
	readonly path: string;
	readonly file: string;
	readonly status: number | null;
	readonly navigationError: string | null;
	readonly settled: boolean;
	readonly uncaughtErrors: readonly string[];
	readonly consoleErrors: readonly string[];
	readonly failedRequests: readonly string[];
};

// Failures mean the page itself is broken; warnings are worth reading but
// can be expected (a feature that answers 503 while it is switched off).
export type PageFindings = {
	readonly failures: readonly string[];
	readonly warnings: readonly string[];
};

export async function shoot(options: ShotOptions): Promise<void> {
	const root = process.cwd();
	mkdirSync(options.outDir, { recursive: true });
	const reports = await withServer(options.server, root, async (origin) => {
		const credentials = credentialsFor(
			options.identity,
			options.server,
			root
		);
		const session =
			credentials === null ? null : await signIn(origin, credentials);
		return shootAll(origin, session, options);
	});
	const findings = reports.map(pageFindings);
	const failingCount = findings.filter((f) => f.failures.length > 0).length;
	const warningCount = findings.filter((f) => f.warnings.length > 0).length;
	if (failingCount > 0)
		throw new CommandError(
			`${failingCount} of ${reports.length} pages did not load or threw (listed above); the PNGs were still written.`
		);
	if (warningCount > 0)
		process.stdout.write(
			`\n${warningCount} of ${reports.length} pages logged console errors or failed requests (listed above).\n`
		);
}

async function shootAll(
	origin: string,
	session: Session | null,
	options: ShotOptions
): Promise<PageReport[]> {
	const browser = await chromium.launch();
	const reports: PageReport[] = [];
	try {
		for (const viewport of options.viewports) {
			const context = await browser.newContext({
				baseURL: origin,
				viewport: { width: viewport.width, height: viewport.height },
				deviceScaleFactor: viewport.mobile ? 2 : 1,
				isMobile: viewport.mobile,
				hasTouch: viewport.mobile,
			});
			if (session !== null)
				await context.addCookies(
					session.cookies.map((cookie) => ({
						...cookie,
						url: origin,
					}))
				);
			for (const target of options.targets) {
				const file = path.join(
					options.outDir,
					`${target.fileStem}.${viewport.name}.png`
				);
				const report = await shootPage(context, target.path, {
					file,
					fullPage: options.fullPage,
				});
				printReport(report);
				reports.push(report);
			}
			await context.close();
		}
	} finally {
		await browser.close();
	}
	return reports;
}

async function shootPage(
	context: BrowserContext,
	appPath: string,
	output: { readonly file: string; readonly fullPage: boolean }
): Promise<PageReport> {
	const page = await context.newPage();
	const uncaughtErrors: string[] = [];
	const consoleErrors: string[] = [];
	const failedRequests: string[] = [];
	recordPageProblems(page, { uncaughtErrors, consoleErrors, failedRequests });
	let status: number | null = null;
	let navigationError: string | null = null;
	try {
		const response = await page.goto(appPath, {
			waitUntil: "load",
			timeout: NAVIGATION_TIMEOUT_MS,
		});
		status = response?.status() ?? null;
	} catch (error: unknown) {
		// A timeout or refused navigation is a finding about this page; the
		// screenshot still shows what the browser got.
		if (!(error instanceof Error)) throw error;
		navigationError = error.message.split("\n", 1)[0] ?? error.name;
	}
	const settled = await settle(page);
	await page.screenshot({ path: output.file, fullPage: output.fullPage });
	await page.close();
	return {
		path: appPath,
		file: output.file,
		status,
		navigationError,
		settled,
		uncaughtErrors,
		consoleErrors,
		failedRequests,
	};
}

function recordPageProblems(
	page: Page,
	into: {
		readonly uncaughtErrors: string[];
		readonly consoleErrors: string[];
		readonly failedRequests: string[];
	}
): void {
	const add = (list: string[], message: string) => {
		if (list.length < MESSAGES_PER_PAGE_MAX)
			list.push(message.slice(0, MESSAGE_CHARACTERS_MAX));
	};
	page.on("console", (message) => {
		if (message.type() !== "error") return;
		// Chromium logs every failed subresource; failedRequests already
		// lists them with their method and path.
		if (message.text().startsWith("Failed to load resource")) return;
		add(into.consoleErrors, message.text());
	});
	page.on("pageerror", (error) => add(into.uncaughtErrors, error.message));
	page.on("response", (response) => {
		const request = response.request();
		// The page's own status is reported separately.
		if (
			request.isNavigationRequest() &&
			request.frame() === page.mainFrame()
		)
			return;
		if (response.status() >= 400)
			add(
				into.failedRequests,
				`HTTP ${response.status()} ${request.method()} ${requestPath(response.url())}`
			);
	});
	page.on("requestfailed", (request) => {
		const reason = request.failure()?.errorText ?? "failed";
		// Requests the page cancelled itself (navigation, aborted fetches).
		if (reason === "net::ERR_ABORTED") return;
		add(
			into.failedRequests,
			`${reason} ${request.method()} ${requestPath(request.url())}`
		);
	});
}

// Network quiet, then fonts loaded, so the PNG shows the page as a person
// would see it rather than a loading state or fallback glyphs.
async function settle(page: Page): Promise<boolean> {
	try {
		await page.waitForLoadState("networkidle", {
			timeout: SETTLE_TIMEOUT_MS,
		});
	} catch (error: unknown) {
		if (error instanceof errors.TimeoutError) return false;
		throw error;
	}
	await page.evaluate("document.fonts.ready.then(() => true)");
	return true;
}

function requestPath(url: string): string {
	const parsed = new URL(url);
	return `${parsed.pathname}${parsed.search}`;
}

export function pageFindings(report: PageReport): PageFindings {
	const failures: string[] = [];
	if (report.navigationError !== null)
		failures.push(`navigation failed: ${report.navigationError}`);
	if (
		report.status !== null &&
		(report.status < 200 || report.status > 299)
	) {
		const hint = report.path.startsWith(`${PAGE_BASE_PATH}/`)
			? ""
			: ` (app pages are under ${PAGE_BASE_PATH}; drop the leading slash to use it)`;
		failures.push(`page answered HTTP ${report.status}${hint}`);
	}
	for (const message of report.uncaughtErrors)
		failures.push(`uncaught: ${message}`);
	const warnings = [
		...report.consoleErrors.map((message) => `console error: ${message}`),
		...report.failedRequests,
	];
	return { failures, warnings };
}

function printReport(report: PageReport): void {
	const sizeKilobytes = Math.round(statSync(report.file).size / 1_024);
	const status = report.status === null ? "---" : String(report.status);
	const pending = report.settled ? "" : "  (still loading when captured)";
	process.stdout.write(
		`${status} ${report.path}  ->  ${report.file} (${sizeKilobytes} KB)${pending}\n`
	);
	const findings = pageFindings(report);
	for (const failure of findings.failures)
		process.stdout.write(`    error: ${failure}\n`);
	for (const warning of findings.warnings)
		process.stdout.write(`    warning: ${warning}\n`);
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: SHOT_USAGE,
		parse: () => parseShotOptions(process.argv.slice(2)),
		run: shoot,
	});
