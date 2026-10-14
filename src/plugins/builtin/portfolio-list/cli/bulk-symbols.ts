import type { CliCommandContext } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import { loadSavedListing, parseListingArg } from "../../../../cli/listing-arg";
import { StagedTickerRepository } from "../../../../cli/staged-tickers";
import { splitSymbolArgs, symbolInputKey } from "../../../../cli/symbol-args";
import { readSymbolList, SymbolListError } from "../../../../cli/symbol-list";
import { cliStyles } from "../../../../utils/cli-output";
import {
  addSymbols,
  failedRow,
  listingRow,
  NO_MATCH,
  reason,
  settled,
  summarizeSymbolRows,
  type BulkSymbolsOptions,
  type SymbolRow,
  type SymbolStatus,
  type Verb,
} from "../../../../cli/symbol-rows";

export { addSymbols };

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

/** A row's line, and under it the coin hint when a bare coin ticker was read as something else. */
function rowLines(row: SymbolRow, verb: Verb): string {
  const line = rowLine(row, verb);
  return row.hint ? `${line}\n  ${cliStyles.warning(row.hint)}` : line;
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
    case "not_found": return cliStyles.danger(`Not found: ${typed}${row.message && !NO_MATCH.test(row.message) ? ` (${reason(row.message, typed)})` : ""}${row.suggestion ? `; did you mean ${row.suggestion}?` : ""}`);
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
 * CSV. A separator dropped from a symbol of the list is named as a warning. The
 * command exits non-zero when no symbol ended up as asked.
 */
export function printSymbolRows(
  ctx: CliCommandContext,
  rows: SymbolRow[],
  { verb, collection, repeated, strays }: { verb: Verb; collection: CollectionRef; repeated: number; strays: readonly string[] },
): void {
  const summary = `${collection.kind === "watchlist" ? "Watchlist" : "Portfolio"} "${collection.name}": ${summarizeSymbolRows(rows, verb, repeated)}`;
  const count = (status: SymbolStatus) => rows.filter((row) => row.status === status).length;
  const counts = verb === "add"
    ? { added: count("added"), alreadyListed: count("already_listed"), notFound: count("not_found"), notAdded: count("failed") }
    : { removed: count("removed"), notListed: count("not_listed"), notFound: count("not_found"), notRemoved: count("failed") };
  ctx.printResult({
    data: rows,
    metadata: { [collection.kind]: collection.name, ...counts, repeated, summary },
    ...strays.length > 0 ? { warnings: [...strays] } : {},
  }, {
    text: () => [...rows.map((row) => rowLines(row, verb)), "", summary].join("\n"),
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
): Promise<{ symbols: string[]; repeated: number; strays: string[]; single: string | null }> {
  try {
    const list = await readSymbolList({ args, file });
    if (list.symbols.length === 0) ctx.fail(usage);
    // One symbol typed alone keeps the single-symbol output and errors. It goes as typed, so a separator
    // left on it (`UPST;`) is named by the listing it resolves to.
    const typed = splitSymbolArgs(args);
    const single = file == null && !args.includes("-") && typed.length === 1 ? (args.length === 1 ? args[0]!.trim() : typed[0]!) : null;
    return { ...list, single };
  } catch (error) {
    if (error instanceof SymbolListError) ctx.fail(error.message, usage);
    throw error;
  }
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
