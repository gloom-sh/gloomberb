import type { AppPersistence } from "../data/app-persistence";
import { ApiRequestError } from "../api-client/errors";
import { DEFAULT_CLI_OPTIONS, type CliGlobalOptions } from "./options";
import { serializeCliError, type CliErrorObject } from "./result";
import { cliStyles, cliTerminalWidth, wrapText } from "../utils/cli-output";
import { withSearchHints, type FredSeriesCheck } from "./not-a-ticker";

const USAGE_PREFIX = "Usage: ";
/** The code of every error a command fails with: bad input, nothing found, an option it does not take. */
const CLI_ERROR_CODE = "cli_error";

export interface CliErrorContext {
  /** The command that failed, used to point at its help. */
  command?: string;
  /** What the user typed after the command, so a hint can repeat their own spelling of a symbol. */
  args?: readonly string[];
  /** Which symbols are FRED series the catalog charts, so their hint is `gloomberb fred`. */
  isFredSeries?: FredSeriesCheck;
}

class CliFailure extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly retryable?: boolean;
  /** What a structured format carries beside the message; text prints the message alone. */
  readonly fields?: Record<string, unknown>;

  constructor(message: string, details?: unknown, code = CLI_ERROR_CODE, retryable?: boolean, fields?: Record<string, unknown>) {
    super(message);
    this.name = "CliFailure";
    this.code = code;
    this.details = details;
    this.retryable = retryable;
    this.fields = fields;
  }
}

export function fail(message: string, details?: unknown, code?: string): never {
  throw new CliFailure(message, details, code);
}

/**
 * Fails with its own code and the fields `--json` reads beside the message:
 * `{ ok: false, error: { code, message, ...fields } }`. Text prints the
 * message alone, and the exit status is any failure's.
 */
export function failWithFields(message: string, code: string, fields: Record<string, unknown>): never {
  throw new CliFailure(message, undefined, code, undefined, fields);
}

/** Fails with what asking again shortly may get past (a busy service): `--json` marks it `retryable`. */
export function failRetryable(message: string, code: string): never {
  throw new CliFailure(message, undefined, code, true);
}

export function closeAndFail(persistence: AppPersistence, message: string, details?: string): never {
  persistence.close();
  fail(message, details);
}

export function isCliFailure(error: unknown): error is CliFailure {
  return error instanceof CliFailure;
}

/** A global option that does not parse is a usage error like any other, not an unexpected one. */
export function asUsageError(error: unknown): Error {
  return isCliFailure(error) ? error : new CliFailure(error instanceof Error ? error.message : String(error));
}

function cliErrorObject(error: unknown): CliErrorObject {
  if (isCliFailure(error)) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
      retryable: error.retryable,
      ...error.fields,
    };
  }
  // Gloom Cloud refused what was asked (an unknown series, a bad date): the input was wrong, not the program.
  if (error instanceof ApiRequestError && error.status === 400) {
    return { code: CLI_ERROR_CODE, message: error.message };
  }
  return {
    code: "unexpected_error",
    message: error instanceof Error ? error.message : String(error),
  };
}

export function inferCliErrorOptions(rawArgs: string[]): CliGlobalOptions {
  const options: CliGlobalOptions = { ...DEFAULT_CLI_OPTIONS };
  for (const arg of rawArgs) {
    if (arg === "--") break;
    if (arg === "--json") options.format = "json";
    if (arg === "--csv") options.format = "csv";
    if (arg === "--ndjson") options.format = "ndjson";
    if (arg === "--quiet" || arg === "-q") options.quiet = true;
    if (arg === "--no-color") options.color = false;
    if (arg === "--color") options.color = true;
  }
  return options;
}

function formatCliErrorText(error: CliErrorObject, context: CliErrorContext): string {
  const width = cliTerminalWidth();
  const details = error.details == null
    ? []
    : width == null ? String(error.details).split("\n") : wrapText(String(error.details), width);
  if (error.message.startsWith(USAGE_PREFIX)) {
    const lines = [
      `${cliStyles.heading("Usage:")} ${error.message.slice(USAGE_PREFIX.length)}`,
      ...details.map((line) => cliStyles.muted(line)),
    ];
    if (context.command) {
      lines.push(cliStyles.muted(`Run gloomberb help ${context.command} for details.`));
    }
    return lines.join("\n");
  }
  return [
    `${cliStyles.danger(cliStyles.bold("error:"))} ${error.message}`,
    ...details.map((line) => cliStyles.muted(line)),
  ].join("\n");
}

function hintedError(error: CliErrorObject, args: readonly string[], isFredSeries?: FredSeriesCheck): CliErrorObject {
  return {
    ...error,
    message: withSearchHints(error.message, args, isFredSeries),
    ...(typeof error.details === "string" ? { details: withSearchHints(error.details, args, isFredSeries) } : {}),
  };
}

export function printCliError(error: unknown, options: CliGlobalOptions, context: CliErrorContext = {}): void {
  if (options.quiet && options.format === "text") return;
  const errorObject = cliErrorObject(error);
  console.error(options.format === "text"
    ? formatCliErrorText(hintedError(errorObject, context.args ?? [], context.isFredSeries), context)
    : serializeCliError(errorObject, options));
}
