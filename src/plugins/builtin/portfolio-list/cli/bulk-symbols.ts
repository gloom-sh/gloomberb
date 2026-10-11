import type { CliCommandContext } from "../../../../types/plugin";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerRecord } from "../../../../types/ticker";
import type { TickerRepository } from "../../../../data/ticker-repository";
import { loadSavedListing, parseListingArg, savedListingName } from "../../../../cli/listing-arg";
import { StagedTickerRepository } from "../../../../cli/staged-tickers";
import { splitSymbolArgs } from "../../../../cli/symbol-args";
import { readSymbolList, symbolInputKey, SymbolListError } from "../../../../cli/symbol-list";
import { resolveTickersForCli, TickerNotFoundError } from "../../../../cli/ticker-resolution";
import { cliStyles } from "../../../../utils/cli-output";
import { listingFields } from "./shared";

/** The `--file` option of add and remove. */
export const FILE_OPTION = {
  flags: "--file <path>",
  description: "add, remove: read the symbols from a CSV or text file (- reads standard input)",
};

/** The help section on giving add and remove several symbols. */
export const SYMBOL_LIST_HELP = {
  title: "Several symbols",
  lines: [
    "add and remove take any number of symbols split by spaces, commas or newlines, a --file, or piped input (or -). A CSV is read from its Symbol, Ticker or Code column, else its first. Quote a list name with spaces.",
    "Each symbol gets a line, then a summary. Exit status 0 when at least one symbol was added (or removed) or already was, 1 when none resolved or the usage is wrong.",
  ],
};

/** What became of one symbol of an add or remove. */
type SymbolStatus = "added" | "already_listed" | "removed" | "not_listed" | "not_found" | "failed";

/** One symbol's line: the `--json` and `--csv` row, and a line of text. */
interface SymbolRow extends Record<string, unknown> {
  /** The symbol as given. */
  input: string;
  status: SymbolStatus;
  /** The listing that was stored, SAN:EPA, as the single-symbol commands name it. */
  listing: string | null;
  symbol: string | null;
  exchange: string | null;
  name: string | null;
  /** Why a symbol was not found, added or removed. */
  message: string | null;
  /** What the single-symbol add says beside the listing: the venue a bare symbol went to, a listing that stopped trading. */
  notes: string | null;
}

type Verb = "add" | "remove";

/** The outcomes that leave the list as asked, with how the summary counts them. */
const SETTLED: Record<Verb, ReadonlyArray<readonly [SymbolStatus, string]>> = {
  add: [["added", "added"], ["already_listed", "already in the list"]],
  remove: [["removed", "removed"], ["not_listed", "not in the list"]],
};

function settled(row: SymbolRow, verb: Verb): boolean {
  return SETTLED[verb].some(([status]) => status === row.status);
}

function listingRow(
  input: string,
  status: SymbolStatus,
  ticker: TickerRecord,
  { notes = [], ended = null, extra = {} }: { notes?: string[]; ended?: string | null; extra?: Record<string, unknown> } = {},
): SymbolRow {
  return { input, status, ...listingFields(savedListingName(ticker)), message: ended, notes: notes.join("; ") || null, ...extra };
}

function failedRow(input: string, error: Error, status: SymbolStatus = error instanceof TickerNotFoundError ? "not_found" : "failed"): SymbolRow {
  return { input, status, listing: null, symbol: null, exchange: null, name: null, message: error.message, notes: null };
}

/** The plain no-match answer, which a "Not found" line already says. */
const NO_MATCH = /^No ticker match found for /;

/**
 * "251 added, 5 already in the list, 43 not found: XXXXX, FAKE123; 2 not
 * added: KHC, FITB; 1 repeat skipped." The first count is always there, the
 * others when there are any, and the symbols that went nowhere are named so
 * the list can be fixed.
 */
function summarizeSymbolRows(rows: readonly SymbolRow[], verb: Verb, repeated: number): string {
  const inputs = (status: SymbolStatus) => rows.filter((row) => row.status === status).map((row) => symbolInputKey(row.input));
  const counts = SETTLED[verb]
    .map(([status, word], index) => ({ count: inputs(status).length, word, index }))
    .filter(({ count, index }) => index === 0 || count > 0)
    .map(({ count, word }) => `${count} ${word}`);
  const missing = inputs("not_found");
  if (missing.length > 0) counts.push(`${missing.length} not found: ${missing.join(", ")}`);
  const groups = [counts.join(", ")];
  const failed = inputs("failed");
  if (failed.length > 0) groups.push(`${failed.length} not ${verb === "add" ? "added" : "removed"}: ${failed.join(", ")}`);
  if (repeated > 0) groups.push(`${repeated} repeat${repeated === 1 ? "" : "s"} skipped`);
  return `${groups.join("; ")}.`;
}

/** A message in a line's parentheses, without the subject the line already names or its closing stop. */
function reason(message: string, subject: string): string {
  const text = message.startsWith(`${subject}: `) ? message.slice(subject.length + 2) : message;
  return text.replace(/\.$/, "");
}

function rowLine(row: SymbolRow, verb: Verb): string {
  const typed = symbolInputKey(row.input);
  const label = row.listing ? (row.name ? `${row.listing} (${row.name})` : row.listing) : typed;
  // A listing that stopped trading is still added, and says so.
  const aside = row.message && row.listing ? cliStyles.muted(` (${reason(row.message, label)})`) : "";
  switch (row.status) {
    case "added": return `${cliStyles.success(`Added ${label}`)}${aside}`;
    case "already_listed": return `${cliStyles.warning(`Already in the list: ${label}`)}${aside}`;
    case "removed": return cliStyles.success(`Removed ${label}`);
    case "not_listed": return cliStyles.warning(`Not in the list: ${label}`);
    case "not_found": return cliStyles.danger(`Not found: ${typed}${row.message && !NO_MATCH.test(row.message) ? ` (${reason(row.message, typed)})` : ""}`);
    case "failed": return cliStyles.danger(`Not ${verb === "add" ? "added" : "removed"}: ${typed} (${reason(row.message ?? "", typed)})`);
  }
}

interface CollectionRef {
  kind: "watchlist" | "portfolio";
  name: string;
}

/**
 * One line per symbol and the summary under them; `--json` and `--csv` give
 * the rows, with the summary in the JSON metadata and on standard error beside
 * CSV. The command exits non-zero when no symbol ended up as asked.
 */
export function printSymbolRows(
  ctx: CliCommandContext,
  rows: SymbolRow[],
  { verb, collection, repeated }: { verb: Verb; collection: CollectionRef; repeated: number },
): void {
  const summary = `${collection.kind === "watchlist" ? "Watchlist" : "Portfolio"} "${collection.name}": ${summarizeSymbolRows(rows, verb, repeated)}`;
  const count = (status: SymbolStatus) => rows.filter((row) => row.status === status).length;
  const counts = verb === "add"
    ? { added: count("added"), alreadyListed: count("already_listed"), notFound: count("not_found"), notAdded: count("failed") }
    : { removed: count("removed"), notListed: count("not_listed"), notFound: count("not_found"), notRemoved: count("failed") };
  ctx.printResult({
    data: rows,
    metadata: { [collection.kind]: collection.name, ...counts, repeated, summary },
  }, {
    text: () => [...rows.map((row) => rowLine(row, verb)), "", summary].join("\n"),
  });
  const { format, quiet } = ctx.cliOptions;
  if ((format === "csv" || format === "ndjson") && !quiet) console.error(summary);
  if (!rows.some((row) => settled(row, verb))) process.exitCode = 1;
}

/** A line on standard error while a long add waits to look symbols up again, so it never looks stuck. */
export function retryNotice(ctx: CliCommandContext): (count: number, waitMs: number) => void {
  return (count, waitMs) => {
    if (ctx.cliOptions.quiet) return;
    console.error(cliStyles.muted(`Gloom Cloud refused some requests; looking ${count} symbol${count === 1 ? "" : "s"} up again in ${Math.round(waitMs / 1000)} s.`));
  };
}

/** The symbols an add or remove was given, failing the command when there are none or the file cannot be read. */
export async function requireSymbolList(
  ctx: CliCommandContext,
  args: readonly string[],
  file: string | undefined,
  usage: string,
): Promise<{ symbols: string[]; repeated: number; single: string | null }> {
  try {
    const list = await readSymbolList({ args, file });
    if (list.symbols.length === 0) ctx.fail(usage);
    // One symbol typed alone keeps the single-symbol output and errors.
    const typed = splitSymbolArgs(args);
    const single = file == null && !args.includes("-") && typed.length === 1 ? typed[0]! : null;
    return { ...list, single };
  } catch (error) {
    if (error instanceof SymbolListError) ctx.fail(error.message, usage);
    throw error;
  }
}

interface BulkSymbolsOptions {
  symbols: readonly string[];
  exchange: string | undefined;
  store: TickerRepository;
}

/**
 * Resolves the symbols several at a time and adds each that resolves; one that
 * does not never stops the rest. Every change is written once, at the end.
 */
export async function addSymbols({
  symbols,
  exchange,
  store,
  dataProvider,
  reject,
  add,
  onRetry,
  retry,
}: BulkSymbolsOptions & {
  dataProvider: DataProvider;
  /** Told when requests failed and the symbols that failed are about to be looked up again. */
  onRetry?: (count: number, waitMs: number) => void;
  /** The command that adds one listing, for the choices a failure names. */
  retry?: (key: string) => string;
  /** Why a symbol cannot be added before it is looked up, such as the cash line; null when it can. */
  reject?: (input: string) => Error | null;
  add: (ticker: TickerRecord) => { changed: boolean; ticker: TickerRecord };
}): Promise<SymbolRow[]> {
  const staged = new StagedTickerRepository(store);
  const rejected = new Map(symbols.map((input) => [input, reject?.(input) ?? null] as const));
  const resolutions = await resolveTickersForCli(symbols.filter((input) => !rejected.get(input)), staged, dataProvider, exchange, { onRetry, retry });
  const resolved = new Map(resolutions.map((resolution) => [resolution.input, resolution] as const));
  const rows: SymbolRow[] = [];
  for (const input of symbols) {
    const refusal = rejected.get(input);
    const resolution = resolved.get(input);
    if (refusal || !resolution) {
      rows.push(failedRow(input, refusal ?? new Error("Not looked up.")));
      continue;
    }
    if (resolution.error) {
      rows.push(failedRow(input, resolution.error));
      continue;
    }
    // Read back: an earlier symbol may have added this listing already.
    const current = await staged.loadTicker(resolution.ticker.metadata.ticker) ?? resolution.ticker;
    const result = add(current);
    if (result.changed) await staged.saveTicker(result.ticker);
    rows.push(listingRow(input, result.changed ? "added" : "already_listed", result.ticker, { notes: resolution.notes, ended: resolution.ended }));
  }
  await staged.commit();
  return rows;
}

/**
 * Removes each symbol's saved listing from a collection. A symbol names its
 * listing as the single-symbol remove reads it (SAN:EPA, or `--exchange` for
 * those without one); one that is not saved is not found. Every change is
 * written once, at the end.
 */
export async function removeSymbols({
  symbols,
  exchange,
  store,
  reject,
  remove,
}: BulkSymbolsOptions & {
  reject?: (input: string) => Error | null;
  remove: (ticker: TickerRecord) => { changed: boolean; ticker: TickerRecord; extra?: Record<string, unknown> };
}): Promise<SymbolRow[]> {
  const staged = new StagedTickerRepository(store);
  const rows: SymbolRow[] = [];
  for (const input of symbols) {
    const refusal = reject?.(input);
    if (refusal) {
      rows.push(failedRow(input, refusal));
      continue;
    }
    let listing;
    try {
      listing = parseListingArg(input, exchange, { ownExchangeWins: true });
    } catch (error) {
      rows.push(failedRow(input, error instanceof Error ? error : new Error(String(error))));
      continue;
    }
    const ticker = listing.symbol ? await loadSavedListing(staged, listing) : null;
    if (!ticker) {
      rows.push(failedRow(input, new Error(`Ticker "${listing.key}" was not found in your local data.`), "not_found"));
      continue;
    }
    const result = remove(ticker);
    if (result.changed) await staged.saveTicker(result.ticker);
    rows.push(listingRow(input, result.changed ? "removed" : "not_listed", result.ticker, { extra: result.extra }));
  }
  await staged.commit();
  return rows;
}
