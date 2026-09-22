export type CliOutputFormat = "text" | "json" | "csv" | "ndjson";

export interface CliGlobalOptions {
  format: CliOutputFormat;
  quiet: boolean;
  color: boolean | null;
  limit?: number;
  refresh: boolean;
  dryRun: boolean;
  yes: boolean;
}

export interface ParsedCliArgs {
  args: string[];
  options: CliGlobalOptions;
  /** `--help` or `-h` appeared before `--`. The flag is removed from args. */
  help: boolean;
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

function parseLimit(value: string | undefined): number {
  if (!value) throw new Error("Missing value for --limit.");
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error("--limit must be a positive integer.");
  }
  return parsed;
}

export function parseCliGlobalArgs(rawArgs: string[]): ParsedCliArgs {
  const options: CliGlobalOptions = { ...DEFAULT_CLI_OPTIONS };
  const args: string[] = [];
  let help = false;

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index]!;
    if (arg === "--") {
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
    if (arg === "--limit") {
      index += 1;
      options.limit = parseLimit(rawArgs[index]);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      options.limit = parseLimit(arg.slice("--limit=".length));
      continue;
    }
    args.push(arg);
  }

  return { args, options, help };
}
