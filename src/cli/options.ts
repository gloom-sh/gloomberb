export type CliOutputFormat = "text" | "json" | "csv" | "ndjson";

export interface CliGlobalOptions {
  format: CliOutputFormat;
  quiet: boolean;
  color: boolean | null;
  limit?: number;
  /** `--tail <n>`: the newest n rows of a dated series, in their printed order. Never set with `limit`. */
  tail?: number;
  /** `--width <n>`: fit tables to n columns. Unset, a terminal's own width fits them and piped output is not fitted. */
  width?: number;
  refresh: boolean;
  dryRun: boolean;
  yes: boolean;
}

export interface ParsedCliArgs {
  args: string[];
  options: CliGlobalOptions;
  /** `--help` or `-h` appeared before `--`. The flag is removed from args. */
  help: boolean;
  /** Index in `args` where the arguments after a bare `--` begin; they are never options. */
  literalStart: number;
}

export function isCliHelpFlag(arg: string): boolean {
  return arg === "--help" || arg === "-h";
}

export const DEFAULT_CLI_OPTIONS: CliGlobalOptions = {
  format: "text",
  quiet: false,
  color: null,
  refresh: false,
  dryRun: false,
  yes: false,
};

function parseRowCount(flag: "--limit" | "--tail", value: string | undefined): number {
  if (!value) throw new Error(`Missing value for ${flag}.`);
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

/** Commands whose own `--width` is a size in pixels, so it is not the table width. */
const PIXEL_WIDTH_COMMANDS = new Set(["shot", "screenshot"]);
const MIN_TABLE_WIDTH = 20;

function parseColumnCount(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < MIN_TABLE_WIDTH) {
    throw new Error(`--width must be a whole number of columns, ${MIN_TABLE_WIDTH} or more, such as --width 80.`);
  }
  return parsed;
}

/** The first word that is not an option or the value of one: the command the arguments are for. */
function commandWord(rawArgs: readonly string[]): string | undefined {
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--") return rawArgs[index + 1];
    if (arg === "--limit" || arg === "--tail" || arg === "--width") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

export function parseCliGlobalArgs(rawArgs: string[]): ParsedCliArgs {
  const options: CliGlobalOptions = { ...DEFAULT_CLI_OPTIONS };
  const args: string[] = [];
  let help = false;
  let literalStart: number | null = null;
  const ownsWidth = PIXEL_WIDTH_COMMANDS.has(commandWord(rawArgs)?.toLowerCase() ?? "");

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--") {
      literalStart = args.length;
      args.push(...rawArgs.slice(index + 1));
      break;
    }
    if (isCliHelpFlag(arg)) {
      help = true;
      continue;
    }
    if (arg === "--json") {
      options.format = "json";
      continue;
    }
    if (arg === "--csv") {
      options.format = "csv";
      continue;
    }
    if (arg === "--ndjson") {
      options.format = "ndjson";
      continue;
    }
    if (arg === "--quiet" || arg === "-q") {
      options.quiet = true;
      continue;
    }
    if (arg === "--no-color") {
      options.color = false;
      continue;
    }
    if (arg === "--color") {
      options.color = true;
      continue;
    }
    if (arg === "--refresh") {
      options.refresh = true;
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--yes" || arg === "-y") {
      options.yes = true;
      continue;
    }
    if (!ownsWidth && arg === "--width") {
      index += 1;
      options.width = parseColumnCount(rawArgs[index]);
      continue;
    }
    if (!ownsWidth && arg.startsWith("--width=")) {
      options.width = parseColumnCount(arg.slice("--width=".length));
      continue;
    }
    if (arg === "--limit" || arg === "--tail") {
      index += 1;
      options[arg === "--limit" ? "limit" : "tail"] = parseRowCount(arg, rawArgs[index]);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = parseRowCount("--limit", arg.slice("--limit=".length));
      continue;
    }
    if (arg.startsWith("--tail=")) {
      options.tail = parseRowCount("--tail", arg.slice("--tail=".length));
      continue;
    }
    args.push(arg);
  }
  if (options.limit != null && options.tail != null) {
    throw new Error("Use --limit or --tail, not both: --limit keeps the first rows, --tail the newest.");
  }

  return { args, options, help, literalStart: literalStart ?? args.length };
}
