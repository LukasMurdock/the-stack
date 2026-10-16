// The command-line boundary shared by the TypeScript scripts: argv and env are
// parsed once, at the entry point, into readonly options; everything after
// that works on the parsed values. Usage errors exit 2, failures exit 1.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

export const EXIT_CODE_FAILURE = 1;
export const EXIT_CODE_USAGE = 2;

// A malformed command line. The entry point prints it with the usage text.
export class UsageError extends Error {}

// An expected operational failure (CI failed, production unreachable). The
// entry point prints its message without a stack trace.
export class CommandError extends Error {}

export type Command<Options> =
	| { readonly kind: "help" }
	| { readonly kind: "run"; readonly options: Options };

type ParsedCommandLine<Config extends ParseArgsOptionsConfig> = ReturnType<
	typeof parseArgs<{
		args: string[];
		options: Config;
		allowPositionals: true;
		strict: true;
	}>
>;

// node:util parseArgs in strict mode: unknown flags, missing values and
// values given to boolean flags are usage errors rather than ignored.
export function parseCommandLine<Config extends ParseArgsOptionsConfig>(
	argv: readonly string[],
	options: Config
): ParsedCommandLine<Config> {
	try {
		return parseArgs({
			args: [...argv],
			options,
			allowPositionals: true,
			strict: true,
		});
	} catch (error: unknown) {
		if (error instanceof TypeError && "code" in error) {
			const code = String(error.code);
			if (code.startsWith("ERR_PARSE_ARGS_"))
				throw new UsageError(error.message);
		}
		throw error;
	}
}

export type IntegerBounds = {
	readonly name: string;
	readonly min: number;
	readonly max: number;
};

// Digits only: Number() would also accept "", " 5", "0x10", "1e3" and
// "Infinity", none of which anyone types on purpose.
export function parseBoundedInteger(
	value: string,
	bounds: IntegerBounds
): number {
	if (!/^\d+$/.test(value))
		throw new UsageError(
			`${bounds.name} must be a whole number, got "${value}".`
		);
	const parsed = Number(value);
	if (parsed < bounds.min)
		throw new UsageError(
			`${bounds.name} must be at least ${bounds.min}, got ${value}.`
		);
	if (parsed > bounds.max)
		throw new UsageError(
			`${bounds.name} must be at most ${bounds.max}, got ${value}.`
		);
	return parsed;
}

// True when the module is the script node was asked to run, so importing it
// from a test does not run the command.
export function isEntryPoint(moduleUrl: string): boolean {
	const script = process.argv[1];
	if (script === undefined) return false;
	return realpathSync(script) === realpathSync(fileURLToPath(moduleUrl));
}

export type CliDefinition<Options> = {
	readonly usage: string;
	readonly parse: () => Command<Options>;
	readonly run: (options: Options) => Promise<void>;
};

// The process boundary: the only place that sets the exit code.
export async function runCli<Options>(
	definition: CliDefinition<Options>
): Promise<void> {
	try {
		const command = definition.parse();
		if (command.kind === "help") {
			process.stdout.write(`${definition.usage}\n`);
			return;
		}
		await definition.run(command.options);
	} catch (error: unknown) {
		reportFailure(error, definition.usage);
	}
}

function reportFailure(error: unknown, usage: string): void {
	if (error instanceof UsageError) {
		process.stderr.write(`${error.message}\n\n${usage}\n`);
		process.exitCode = EXIT_CODE_USAGE;
		return;
	}
	process.exitCode = EXIT_CODE_FAILURE;
	if (error instanceof CommandError) {
		process.stderr.write(`\n${error.message}\n`);
	} else if (error instanceof Error) {
		process.stderr.write(`\n${error.stack ?? error.message}\n`);
	} else {
		process.stderr.write(`\n${String(error)}\n`);
	}
}

// Node's errors carry a string `code` (ENOENT, ESRCH, ETIMEDOUT).
export function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null) return undefined;
	if (!("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}
