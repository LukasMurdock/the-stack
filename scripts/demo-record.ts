// `pnpm demo:record <spec>`: runs one browser spec with video on, in the same
// isolated per-port state as `pnpm test:e2e`, and writes the recording where
// a human can open it. Also writes an .mp4 when ffmpeg is installed.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs";
import path from "node:path";
import {
	type Command,
	CommandError,
	errorCode,
	isEntryPoint,
	parseCommandLine,
	runCli,
	UsageError,
} from "./lib/cli.ts";

export const SPEC_DIRECTORY = path.join("tests", "e2e");
export const RECORDINGS_DIRECTORY = path.join(".wrangler", "recordings");
// Playwright's desktop Chrome viewport, so the video is not rescaled.
export const DEMO_VIDEO_SIZE = { width: 1280, height: 720 } as const;
// One spec file holds a handful of tests; more videos than this is a suite.
export const RECORDINGS_MAX = 50;
// Covers a cold build plus a long spec on a loaded machine.
const DEMO_RECORD_TIMEOUT_MS = 30 * 60_000;
const FFMPEG_PROBE_TIMEOUT_MS = 10_000;
const FFMPEG_CONVERT_TIMEOUT_MS = 5 * 60_000;

export const DEMO_RECORD_USAGE = `Usage: pnpm demo:record <spec> [--out <file.webm>]

Runs one Playwright spec with video recording on, against an isolated seeded
server (the same state as pnpm test:e2e), and writes the video. When ffmpeg is
on PATH an .mp4 copy is written next to it.

  <spec>  A spec in ${SPEC_DIRECTORY}: a path ("${SPEC_DIRECTORY}/session.spec.ts"), a name
          ("session"), optionally with :<line> to record a single test.
  --out   Where to write the .webm (default ${RECORDINGS_DIRECTORY}/<spec>.webm). A spec
          with several tests writes <file>-1.webm, <file>-2.webm, ...`;

export type DemoRecordOptions = {
	readonly spec: string;
	readonly out: string;
};

// STACK_E2E_VIDEO, read by playwright.config.ts: "1" records every test.
export function parseDemoVideoEnv(value: string | undefined): boolean {
	if (value === undefined || value === "" || value === "0") return false;
	if (value === "1") return true;
	throw new Error(`STACK_E2E_VIDEO must be 1 or unset, got "${value}".`);
}

export function parseDemoRecordOptions(
	argv: readonly string[],
	root: string
): Command<DemoRecordOptions> {
	const { values, positionals } = parseCommandLine(argv, {
		out: { type: "string" },
		help: { type: "boolean", short: "h" },
	});
	if (values.help === true) return { kind: "help" };
	const [specText, ...extra] = positionals;
	if (specText === undefined) throw new UsageError("Give a spec to record.");
	if (extra.length > 0)
		throw new UsageError(
			`Record one spec at a time; got ${positionals.length}.`
		);
	const match = /^(.+?)(?::(\d+))?$/.exec(specText);
	const file = resolveSpec(match?.[1] ?? specText, root);
	const line = match?.[2];
	const name = path.basename(file, ".spec.ts");
	const out =
		values.out ??
		path.join(
			RECORDINGS_DIRECTORY,
			`${name}${line === undefined ? "" : `-${line}`}.webm`
		);
	if (path.extname(out) !== ".webm")
		throw new UsageError(`--out must end in .webm, got "${out}".`);
	return {
		kind: "run",
		options: { spec: line === undefined ? file : `${file}:${line}`, out },
	};
}

// A path or a bare name -> tests/e2e/<name>.spec.ts, relative to root.
function resolveSpec(value: string, root: string): string {
	const candidates = [value, path.join(SPEC_DIRECTORY, `${value}.spec.ts`)];
	for (const candidate of candidates) {
		const relative = path.relative(root, path.resolve(root, candidate));
		if (!relative.startsWith(`${SPEC_DIRECTORY}${path.sep}`)) continue;
		if (!relative.endsWith(".spec.ts")) continue;
		if (isFile(path.join(root, relative))) return relative;
	}
	throw new UsageError(
		`No spec "${value}" in ${SPEC_DIRECTORY}. Specs: ${listSpecs(root).join(", ")}.`
	);
}

function isFile(file: string): boolean {
	try {
		return statSync(file).isFile();
	} catch (error: unknown) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function listSpecs(root: string): string[] {
	return readdirSync(path.join(root, SPEC_DIRECTORY))
		.filter((name) => name.endsWith(".spec.ts"))
		.map((name) => name.slice(0, -".spec.ts".length))
		.sort();
}

export async function demoRecord(options: DemoRecordOptions): Promise<void> {
	mkdirSync(RECORDINGS_DIRECTORY, { recursive: true });
	const outputDir = mkdtempSync(path.join(RECORDINGS_DIRECTORY, ".run-"));
	const exitCode = await runToExit(
		spawn(
			"pnpm",
			["exec", "playwright", "test", options.spec, "--output", outputDir],
			{ stdio: "inherit", env: { ...process.env, STACK_E2E_VIDEO: "1" } }
		),
		DEMO_RECORD_TIMEOUT_MS
	);
	const videos = findVideos(outputDir);
	const written = writeRecordings(videos, options.out);
	if (exitCode !== 0)
		throw new CommandError(
			`The spec failed (exit ${exitCode}); ${written.length} recording(s) of the run were still written. Traces are in ${outputDir}.`
		);
	rmSync(outputDir, { recursive: true, force: true });
	if (written.length === 0)
		throw new CommandError(
			`No test in ${options.spec} ran, so nothing was recorded.`
		);
}

// Playwright writes <outputDir>/<test>/video.webm; sorted for stable names.
export function findVideos(outputDir: string): string[] {
	const videos = readdirSync(outputDir, { recursive: true, encoding: "utf8" })
		.filter((name) => name.endsWith(".webm"))
		.sort()
		.map((name) => path.join(outputDir, name));
	if (videos.length > RECORDINGS_MAX)
		throw new CommandError(
			`The spec produced ${videos.length} videos; record at most ${RECORDINGS_MAX} (pick one test with <spec>:<line>).`
		);
	return videos;
}

// One video keeps the requested name; several are numbered after it.
export function recordingNames(out: string, count: number): string[] {
	if (count === 1) return [out];
	const stem = out.slice(0, -".webm".length);
	return Array.from(
		{ length: count },
		(_, index) => `${stem}-${index + 1}.webm`
	);
}

function writeRecordings(videos: readonly string[], out: string): string[] {
	const names = recordingNames(out, videos.length);
	const ffmpeg = ffmpegAvailable();
	mkdirSync(path.dirname(out), { recursive: true });
	for (const [index, video] of videos.entries()) {
		const name = names[index];
		if (name === undefined)
			throw new Error("Invariant violated: one name per video.");
		copyFileSync(video, name);
		process.stdout.write(`Recorded ${name} (${kilobytes(name)} KB)\n`);
		if (ffmpeg) convertToMp4(name);
	}
	if (!ffmpeg && videos.length > 0)
		process.stdout.write("ffmpeg is not on PATH; skipped the .mp4 copy.\n");
	return names.slice(0, videos.length);
}

function ffmpegAvailable(): boolean {
	const probe = spawnSync("ffmpeg", ["-version"], {
		stdio: "ignore",
		timeout: FFMPEG_PROBE_TIMEOUT_MS,
	});
	if (errorCode(probe.error) === "ENOENT") return false;
	if (probe.error !== undefined) throw probe.error;
	return probe.status === 0;
}

// H.264 in yuv420p plays in every browser, chat client and QuickTime.
function convertToMp4(webm: string): void {
	const mp4 = `${webm.slice(0, -".webm".length)}.mp4`;
	const result = spawnSync(
		"ffmpeg",
		[
			"-y",
			"-loglevel",
			"error",
			"-i",
			webm,
			"-c:v",
			"libx264",
			"-pix_fmt",
			"yuv420p",
			"-movflags",
			"+faststart",
			mp4,
		],
		{
			stdio: ["ignore", "inherit", "inherit"],
			timeout: FFMPEG_CONVERT_TIMEOUT_MS,
		}
	);
	if (result.error !== undefined) throw result.error;
	if (result.status !== 0)
		throw new CommandError(
			`ffmpeg could not convert ${webm} (exit ${result.status}).`
		);
	process.stdout.write(`Converted ${mp4} (${kilobytes(mp4)} KB)\n`);
}

function kilobytes(file: string): number {
	return Math.round(statSync(file).size / 1_024);
}

function runToExit(child: ChildProcess, timeoutMs: number): Promise<number> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			reject(
				new CommandError(
					`The spec ran longer than ${timeoutMs / 60_000} minutes.`
				)
			);
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			clearTimeout(timer);
			resolve(code ?? (signal === null ? 1 : 128));
		});
	});
}

if (isEntryPoint(import.meta.url))
	await runCli({
		usage: DEMO_RECORD_USAGE,
		parse: () =>
			parseDemoRecordOptions(process.argv.slice(2), process.cwd()),
		run: demoRecord,
	});
