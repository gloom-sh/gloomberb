import type { CliCommandContext } from "../../../../types/plugin";
import type { TickerRecord } from "../../../../types/ticker";
import type { MarketContext } from "../../../../cli/types";
import { listingFields, loadSavedListing, parseListingArg, savedListingName } from "../../../../cli/listing-arg";
import { withSuggestion } from "../../../../cli/listing-suggestion";
import { StagedTickerRepository } from "../../../../cli/staged-tickers";
import { splitSymbolWords, symbolInputKey } from "../../../../cli/symbol-args";
import { readSymbolList, SymbolListError } from "../../../../cli/symbol-list";
import { cliStyles } from "../../../../utils/cli-output";
import { dryRunNote } from "../../../../cli/helpers";
import {
  addSymbol,
  addSymbols,
  failedReason,
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
import { failPortfolioCommand } from "./shared";

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
    "add and remove take any number of symbols split by spaces, commas or newlines, a --file, or piped input (or -). An entry of a list with commas or newlines that has spaces in it is a company's name when search finds one, read as its US listing first with a line under it saying which, and otherwise the symbols it holds. A CSV is read from its Symbol, Ticker or Code column. Without that header every cell is a symbol, unless names, prices or weights sit beside them: then the first column is read and the cells left out are named. Quote a list name with spaces.",
    "Each symbol gets a line, then a summary. Exit status 0 when at least one symbol was added (or removed) or already was, 1 when none resolved or the usage is wrong.",
    "A bare US-style symbol is not added when the listing it matched stopped trading, is abroad (DFS as DFS:LSE) or was taken by another company in the last two years (BRKL), or when nothing lists under it now and its company trades as another. Those are listed under Needs a choice, with the add for what their company trades as now and the listing that matched, which naming keeps; one symbol alone fails with the same. A symbol another company took longer ago says so under its line.",
    "add --dry-run looks every symbol up and prints the same lines without saving.",
  ],
};

/**
 * A row's line, and under it the listing a company's name was read as, the
 * company that had the symbol before the listing added, and the coin hint
 * when a bare coin ticker was read as something else.
 */
function rowLines(row: SymbolRow, verb: Verb): string {
  return [
    rowLine(row, verb),
    ...row.readAs ? [`  ${cliStyles.muted(row.readAs)}`] : [],
    ...row.changeNote ? [`  ${cliStyles.warning(row.changeNote)}`] : [],
    ...row.hint ? [`  ${cliStyles.warning(row.hint)}`] : [],
  ].join("\n");
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
    case "needs_choice": return cliStyles.warning(`  ${row.message ?? typed}`);
    case "failed": return cliStyles.danger(`Not ${verb === "add" ? "added" : "removed"}: ${typed} (${failedReason(row, typed)})`);
  }
}

/**
 * What symbols that need a choice offer: the add that takes the companies
 * they trade as now, and the add that keeps each match as it is by naming its
 * listing. Null for an offer the symbols do not have.
 */
function choiceOffers(choices: readonly SymbolRow[], retry: ((keys: string) => string) | undefined): { successors: string | null; matches: string | null } {
  const successors = [...new Set(choices.flatMap((row) => row.tradesAs ? [row.tradesAs] : []))];
  const matches = [...new Set(choices.flatMap((row) => row.listing ? [row.listing] : []))];
  const command = (keys: string[]) => retry ? retry(keys.join(" ")) : keys.join(" ");
  const one = choices.length === 1;
  return {
    successors: successors.length > 0 ? `Add what ${one ? "it trades" : "they trade"} as now: ${command(successors)}` : null,
    matches: matches.length > 0 ? `To keep ${one ? "the" : "a"} match instead, name its listing: ${command(matches)}` : null,
  };
}

/**
 * The symbols of an add that need a choice, under their own heading after the
 * other lines: why each was not added, then what they offer (`choiceOffers`).
 */
function choiceLines(rows: readonly SymbolRow[], retry: ((keys: string) => string) | undefined): string[] {
  const choices = rows.filter((row) => row.status === "needs_choice");
  if (choices.length === 0) return [];
  const { successors, matches } = choiceOffers(choices, retry);
  return [
    ...rows.length > choices.length ? [""] : [],
    cliStyles.warning(`Needs a choice, not added (${choices.length}):`),
    ...choices.map((row) => rowLines(row, "add")),
    ...successors ? [successors] : [],
    ...matches ? [cliStyles.muted(matches)] : [],
  ];
}

interface CollectionRef {
  kind: "watchlist" | "portfolio";
  name: string;
}

/**
 * One line per symbol and the summary under them; `--json` and `--csv` give
 * the rows, with the summary in the JSON metadata and on standard error beside
 * CSV. A separator dropped from a symbol of the list, and the cells a table
 * read by one column left out, are named as warnings. The command exits
 * non-zero when no symbol ended up as asked.
 */
export function printSymbolRows(
  ctx: CliCommandContext,
  rows: SymbolRow[],
  { verb, collection, repeated, notes, retry, dryRun = false }: {
    verb: Verb; collection: CollectionRef; repeated: number; notes: readonly string[];
    /** The add of some listings, for the line that adds what the symbols needing a choice trade as now. */
    retry?: (keys: string) => string;
    dryRun?: boolean;
  },
): void {
  const summary = `${collection.kind === "watchlist" ? "Watchlist" : "Portfolio"} "${collection.name}": ${summarizeSymbolRows(rows, verb, repeated)}`;
  const count = (status: SymbolStatus) => rows.filter((row) => row.status === status).length;
  const counts = verb === "add"
    ? { added: count("added"), alreadyListed: count("already_listed"), notFound: count("not_found"), notAdded: count("failed"),
      ...count("needs_choice") > 0 ? { needsChoice: count("needs_choice") } : {} }
    : { removed: count("removed"), notListed: count("not_listed"), notFound: count("not_found"), notRemoved: count("failed") };
  ctx.printResult({
    data: rows,
    metadata: { [collection.kind]: collection.name, ...counts, repeated, summary, ...dryRun ? { dryRun } : {} },
    ...notes.length > 0 ? { warnings: [...notes] } : {},
  }, {
    text: () => [
      ...rows.filter((row) => row.status !== "needs_choice").map((row) => rowLines(row, verb)),
      ...choiceLines(rows, retry),
      "",
      `${summary}${dryRunNote(dryRun)}`,
    ].join("\n"),
  });
  const { format, quiet } = ctx.cliOptions;
  if ((format === "csv" || format === "ndjson") && !quiet) console.error(summary);
  if (!rows.some((row) => settled(row, verb))) process.exitCode = 1;
}

/**
 * `watchlist add` and `portfolio add` given one symbol: added as a symbol of a
 * list is (`addSymbol`), and said as one listing, added or already there with
 * its notes as warnings. A symbol a list would leave for a choice fails the
 * command, saying why, with what a list offers under the error; any other
 * failure fails it as the lookup's error, a busy service's to retry.
 */
export async function addOneSymbol(
  ctx: CliCommandContext,
  market: MarketContext,
  { symbol, exchange, collection, retry, reject, add }: {
    symbol: string;
    exchange: string | undefined;
    collection: CollectionRef;
    /** The add of one listing, for the choices a failure names. */
    retry: (key: string) => string;
    reject?: (input: string) => Error | null;
    add: (ticker: TickerRecord) => { changed: boolean; ticker: TickerRecord };
  },
): Promise<void> {
  const { dataProvider, store } = market;
  const dryRun = ctx.cliOptions.dryRun;
  const { row, error, lookup } = await addSymbol(symbol, { exchange, store, dataProvider, reject, retry, dryRun, add });
  if (row.status === "needs_choice") {
    const message = row.message ?? symbol;
    const { successors, matches } = choiceOffers([row], retry);
    ctx.fail(/[.!?]$/.test(message) ? message : `${message}.`, [successors, matches].filter(Boolean).join("\n"));
  }
  if (error || !lookup) {
    return failPortfolioCommand(ctx, await withSuggestion(error, symbol, { store, dataProvider }), `Failed to add ${symbol} to "${collection.name}".`);
  }
  // Name the listing that was stored: SAN:EPA is not the SAN that a bare SAN means.
  const saved = savedListingName(lookup.ticker);
  const changed = row.status === "added";
  const { change, formerIssuer, notes } = lookup;
  const data = { changed, ...listingFields(saved), [collection.kind]: collection.name,
    ...change ? { tickerChange: change } : {}, ...formerIssuer ? { formerIssuer } : {}, ...dryRun ? { dryRun } : {} };
  const warnings = notes.length > 0 ? notes : undefined;
  ctx.printResult({ data, warnings }, {
    text: () => changed
      ? `${cliStyles.success(`Added ${saved.label} to "${collection.name}".`)}${dryRunNote(dryRun)}`
      : cliStyles.warning(`${saved.label} is already in "${collection.name}".`),
  });
}

/** A line on standard error while a long add waits to look symbols up again, so it never looks stuck. */
export function retryNotice(ctx: CliCommandContext): (count: number, waitMs: number) => void {
  return (count, waitMs) => {
    if (ctx.cliOptions.quiet) return;
    console.error(cliStyles.muted(`Gloom Cloud refused some requests; looking ${count} symbol${count === 1 ? "" : "s"} up again in ${Math.round(waitMs / 1000)} s.`));
  };
}

/**
 * The symbols an add or remove was given, failing the command when there are
 * none or the file cannot be read. An add reads a typed company's name with
 * `readNameEntries`; without it (a remove) every entry is its words.
 */
export async function requireSymbolList(
  ctx: CliCommandContext,
  args: readonly string[],
  file: string | undefined,
  usage: string,
  readEntries?: (entries: string[]) => Promise<string[]>,
): Promise<{ symbols: string[]; repeated: number; notes: string[]; single: string | null }> {
  try {
    let typed: string[] = [];
    const list = await readSymbolList({ args, file, readEntries: async (entries) => {
      typed = readEntries ? await readEntries(entries) : splitSymbolWords(entries);
      return typed;
    } });
    if (list.symbols.length === 0) ctx.fail(usage);
    // One symbol typed alone keeps the single-symbol output and errors. It goes as typed, so a separator
    // left on it (`UPST;`) is named by the listing it resolves to.
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
