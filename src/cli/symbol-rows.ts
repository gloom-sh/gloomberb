import type { DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import { listingFields, savedListingName } from "./listing-arg";
import { StagedTickerRepository, type TickerSource } from "./staged-tickers";
import { symbolInputKey } from "./symbol-args";
import { describeSuggestion, isPlainNoMatch, suggestListings } from "./listing-suggestion";
import { CoinListingError, resolveTickersForCli, TickerNotFoundError } from "./ticker-resolution";

/** What became of one symbol of an add or remove. */
export type SymbolStatus = "added" | "already_listed" | "removed" | "not_listed" | "not_found" | "failed";

/** One symbol's line: the `--json` and `--csv` row, and a line of text. */
export interface SymbolRow extends Record<string, unknown> {
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
  /** How the symbol was read, when not as typed: a company's name as the listing it names. */
  readAs?: string;
  /** A not-found symbol's nearest listing in search, as the line names it: `USDNGN=X (US Dollar/Nigerian Naira)`. Only when asked for and found. */
  suggestion?: string;
  /**
   * A bare coin ticker read as something other than the coin (ETH as a fund, SOL as
   * Solvay), and the pair to use instead. Also in `notes` when the symbol was added.
   */
  hint: string | null;
}

export type Verb = "add" | "remove";

/** The outcomes that leave the list as asked, with how the summary counts them. */
const SETTLED: Record<Verb, ReadonlyArray<readonly [SymbolStatus, string]>> = {
  add: [["added", "added"], ["already_listed", "already in the list"]],
  remove: [["removed", "removed"], ["not_listed", "not in the list"]],
};

export function settled(row: SymbolRow, verb: Verb): boolean {
  return SETTLED[verb].some(([status]) => status === row.status);
}

export function listingRow(
  input: string,
  status: SymbolStatus,
  ticker: TickerRecord,
  { notes = [], ended = null, hint = null, readAs = null, extra = {} }: {
    notes?: string[]; ended?: string | null; hint?: string | null; readAs?: string | null; extra?: Record<string, unknown>;
  } = {},
): SymbolRow {
  return { input, status, ...listingFields(savedListingName(ticker)), message: ended, notes: notes.join("; ") || null, hint,
    ...readAs ? { readAs } : {}, ...extra };
}

export function failedRow(input: string, error: Error, status: SymbolStatus = error instanceof TickerNotFoundError ? "not_found" : "failed"): SymbolRow {
  const hint = error instanceof CoinListingError ? error.hint : null;
  return { input, status, listing: null, symbol: null, exchange: null, name: null, message: error.message, notes: null, hint };
}

/** The plain no-match answer, which a "Not found" line already says. */
export const NO_MATCH = /^No ticker match found for /;

/**
 * "251 added, 5 already in the list, 43 not found: XXXXX, FAKE123; 2 not
 * added: KHC, FITB; 1 repeat skipped." The first count is always there, the
 * others when there are any, and the symbols that went nowhere are named so
 * the list can be fixed.
 */
export function summarizeSymbolRows(rows: readonly SymbolRow[], verb: Verb, repeated: number): string {
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
export function reason(message: string, subject: string): string {
  const text = message.startsWith(`${subject}: `) ? message.slice(subject.length + 2) : message;
  return text.replace(/\.$/, "");
}

export interface BulkSymbolsOptions {
  symbols: readonly string[];
  exchange: string | undefined;
  store: TickerSource;
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
  askWhenAmbiguous,
  failure,
  suggest,
}: BulkSymbolsOptions & {
  dataProvider: DataProvider;
  /** Told when requests failed and the symbols that failed are about to be looked up again. */
  onRetry?: (count: number, waitMs: number) => void;
  /** The command that adds one listing, for the choices a failure names. */
  retry?: (key: string) => string;
  /** Why a symbol cannot be added before it is looked up, such as the cash line; null when it can. */
  reject?: (input: string) => Error | null;
  /** A bare symbol with several listings is not added to the first that has a quote: it fails with the choice. */
  askWhenAmbiguous?: boolean;
  /** Rewrites the error a symbol failed with before it is reported, to say it as the caller's own surface does. */
  failure?: (error: Error) => Error;
  /** A symbol search finds no listing for is given the nearest listing search knows, when it is a near match (USD_NGN, USDNGN=X). */
  suggest?: boolean;
  /** May throw to refuse the listing (an alias of a holding in two records); that symbol fails alone. */
  add: (ticker: TickerRecord) => { changed: boolean; ticker: TickerRecord };
}): Promise<SymbolRow[]> {
  const staged = new StagedTickerRepository(store);
  const rejected = new Map(symbols.map((input) => [input, reject?.(input) ?? null] as const));
  const resolutions = await resolveTickersForCli(symbols.filter((input) => !rejected.get(input)), staged, dataProvider, exchange, { onRetry, retry, askWhenAmbiguous });
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
      rows.push(failedRow(input, failure?.(resolution.error) ?? resolution.error));
      continue;
    }
    // Read back: an earlier symbol may have added this listing already.
    const current = await staged.loadTicker(resolution.ticker.metadata.ticker) ?? resolution.ticker;
    let result: ReturnType<typeof add>;
    try {
      result = add(current);
    } catch (error) {
      rows.push(failedRow(input, error instanceof Error ? error : new Error(String(error))));
      continue;
    }
    if (result.changed) await staged.saveTicker(result.ticker);
    rows.push(listingRow(input, result.changed ? "added" : "already_listed", result.ticker, { notes: resolution.notes, ended: resolution.ended, hint: resolution.coinNote, readAs: resolution.readAs }));
  }
  await staged.commit();
  return suggest ? withSuggestions(rows, staged, dataProvider) : rows;
}

/** The rows, each symbol search found no listing for with the nearest listing it did find, when that is a near match. */
async function withSuggestions(rows: SymbolRow[], store: StagedTickerRepository, dataProvider: DataProvider): Promise<SymbolRow[]> {
  const missing = rows.filter((row) => row.status === "not_found" && isPlainNoMatch(row.message));
  const suggestions = await suggestListings(missing.map((row) => row.input), { store, dataProvider });
  const byInput = new Map(missing.map((row, index) => [row, suggestions[index] ?? null] as const));
  return rows.map((row) => {
    const suggestion = byInput.get(row);
    return suggestion ? { ...row, suggestion: describeSuggestion(suggestion) } : row;
  });
}
