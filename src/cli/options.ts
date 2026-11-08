export type CliOutputFormat = "text" | "json" | "csv" | "ndjson";

export interface CliGlobalOptions {
  format: CliOutputFormat;
  quiet: boolean;
  color: boolean | null;
  /**
   * `--plain`: tables without rules, arrows in words, every column kept with
   * "—" for an empty cell (`setCliPlainOverride`); `--no-plain` turns it
   * off. Null leaves it to the environment: on with NO_COLOR set to a value,
   * or when stdout is not a terminal (`plainByDefault`).
   */
  plain: boolean | null;
  limit?: number;
  /** `--tail <n>`: the newest n rows of a dated series, in their printed order. Never set with `limit`. */
  tail?: number;
  /** `--width <n>`: fit tables to n columns. Unset, a terminal's own width fits them, and piped output fits `COLUMNS` when set, else is not fitted. */
  width?: number;
  refresh: boolean;
  dryRun: boolean;
  yes: boolean;
  /**
   * `--output <path>` (or `--out`): the file a `--csv`, `--json` or
   * `--ndjson` export is written to, in UTF-8, in place of stdout. A shell's
   * redirect is not always UTF-8: Windows PowerShell 5.1 writes `>` as
   * UTF-16. `fn`, `shot` and a plugin command that declares its own
   * `--output` read the flag themselves.
   */
  output?: string;
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
  plain: null,
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
/** Commands whose own `--output` names their file: a function's report, a capture's PNG. */
const OWN_OUTPUT_COMMANDS = new Set(["fn", "function", "shot", "screenshot"]);
const MIN_TABLE_WIDTH = 20;

function parseColumnCount(value: string | undefined): number {
  const parsed = Number(value);
  if (!value || !Number.isInteger(parsed) || parsed < MIN_TABLE_WIDTH) {
    throw new Error(`--width must be a whole number of columns, ${MIN_TABLE_WIDTH} or more, such as --width 80.`);
  }
  return parsed;
}

function parseOutputFile(value: string | undefined): string {
  if (!value?.trim() || value.startsWith("--")) throw new Error("--output needs a file to write, such as --csv --output report.csv.");
  return value;
}

/** The first word that is not an option or the value of one: the command the arguments are for. */
function commandWord(rawArgs: readonly string[]): string | undefined {
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--") return rawArgs[index + 1];
    if (arg === "--limit" || arg === "--tail" || arg === "--width" || arg === "--output" || arg === "--out") index += 1;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
}

/**
 * Whether a command reads `--output` itself: `fn` and `shot`, and a plugin
 * command whose options declare one. The global flag yields to it.
 */
export function commandOwnsOutput(command: { name: string; help?: { options?: readonly { flags: string }[] } }): boolean {
  return OWN_OUTPUT_COMMANDS.has(command.name.toLowerCase())
    || (command.help?.options ?? []).some((option) => /(^|[\s,])--(output|out)\b/.test(option.flags));
}

/**
 * The global flags out of `rawArgs`. `ownsOutput` says the command reads
 * `--output` itself (commandOwnsOutput), which a built-in's name tells
 * before its plugin is loaded; `deferOutputCheck` leaves refusing `--output`
 * without an export format to `checkCliOutputFormat`, once that is known.
 */
export function parseCliGlobalArgs(rawArgs: string[], settings: { ownsOutput?: boolean; deferOutputCheck?: boolean } = {}): ParsedCliArgs {
  const options: CliGlobalOptions = { ...DEFAULT_CLI_OPTIONS };
  const args: string[] = [];
  let help = false;
  let literalStart: number | null = null;
  const ownsWidth = PIXEL_WIDTH_COMMANDS.has(commandWord(rawArgs)?.toLowerCase() ?? "");
  const ownsOutput = settings.ownsOutput ?? OWN_OUTPUT_COMMANDS.has(commandWord(rawArgs)?.toLowerCase() ?? "");

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
    if (arg === "--plain" || arg === "--no-plain") {
      options.plain = arg === "--plain";
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
    if (!ownsOutput && (arg === "--output" || arg === "--out")) {
      index += 1;
      options.output = parseOutputFile(rawArgs[index]);
      continue;
    }
    if (!ownsOutput && (arg.startsWith("--output=") || arg.startsWith("--out="))) {
      options.output = parseOutputFile(arg.slice(arg.indexOf("=") + 1));
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

  const parsed = { args, options, help, literalStart: literalStart ?? args.length };
  if (!settings.deferOutputCheck) checkCliOutputFormat(parsed);
  return parsed;
}

/** `--output` writes an export: refused without --csv, --json or --ndjson. */
export function checkCliOutputFormat(parsed: Pick<ParsedCliArgs, "options" | "help">): void {
  if (parsed.options.output !== undefined && parsed.options.format === "text" && !parsed.help) {
    throw new Error("--output writes an export: add --csv, --json or --ndjson, such as --csv --output report.csv.");
  }
}
