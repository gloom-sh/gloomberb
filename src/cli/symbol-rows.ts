import type { DataProvider } from "../types/data-provider";
import type { TickerRecord } from "../types/ticker";
import { listingFields, listingVenues, savedListingName, type ListingChoice } from "./listing-arg";
import { StagedTickerRepository, type TickerSource } from "./staged-tickers";
import { symbolInputKey } from "./symbol-args";
import { describeSuggestion, isPlainNoMatch, suggestListings, suggestUsTicker } from "./listing-suggestion";
import { NotASymbolError } from "./symbol-cells";
import {
  CoinListingError,
  ListingChoiceError,
  LookupUnansweredError,
  resolveCliTicker,
  resolveTickersForCli,
  TickerNotFoundError,
  type CliTicker,
  type CliTickerOptions,
  type CliTickerResolution,
} from "./ticker-resolution";
import { isUsSymbolVenue, LOOKUP_TIMEOUT_MS, tickerChangeLine, tickerChangeSymbol } from "../tickers/ticker-changes";
import { isVenueAbroad } from "../tickers/listing-fate";
import { sameCompany } from "../tickers/company-name";
import { tickerHasListingSuffix } from "../sources/listing-symbols";
import { canonicalExchange, exchangeLabel, resolveExchangeTimeZone } from "../utils/exchanges";
import { isCurrencyPairListing } from "../utils/fx-market-hours";
import { isCurrencyCode } from "../utils/currency-pair";
import { logFailure } from "../utils/log-failure";

/**
 * What became of one symbol of an add or remove. `needs_choice`: a symbol of
 * an add whose company moved or merged away, whose listing stopped trading, or
 * that matched only a listing abroad; it is not added, and the row offers what
 * to add instead. `not_a_symbol`: an entry refused before any lookup (`N/A`,
 * `$$$`, a price). `not_looked_up`: Gloom Cloud kept refusing its lookup, so
 * it is neither found nor missing, and is worth adding again.
 */
export type SymbolStatus =
  | "added" | "already_listed" | "removed" | "not_listed" | "not_found" | "needs_choice" | "failed" | "not_a_symbol" | "not_looked_up";

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
  /** A bare symbol several companies list: the first listings to choose from, and how many there are in all. */
  choices?: readonly ListingChoice[];
  listingCount?: number;
  /** What became of a symbol that asks for a choice, as `search` says it: "NEP became XIFR on 2025-02-03". */
  successor?: string;
  /**
   * The symbol the company that held the symbol trades as now (COF for DFS),
   * when it moved or merged away. A row that needs a choice offers it; its
   * listing is the match that was not stored.
   */
  tradesAs?: string | null;
  /** An added row's line saying that company moved or merged away, so the listing stored is another's. */
  changeNote?: string;
  /** A bare symbol added on its only listing, abroad: "GARAN has no US listing; it trades on BIST, in TRY." */
  abroad?: string;
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

/** The status a failure gives its row: not found, not a symbol, not looked up, or failed for its own reason. */
function failureStatus(error: Error): SymbolStatus {
  if (error instanceof TickerNotFoundError) return "not_found";
  if (error instanceof NotASymbolError) return "not_a_symbol";
  if (error instanceof LookupUnansweredError) return "not_looked_up";
  return "failed";
}

export function failedRow(input: string, error: Error, status: SymbolStatus = failureStatus(error)): SymbolRow {
  const hint = error instanceof CoinListingError ? error.hint : null;
  const choice = error instanceof ListingChoiceError
    ? { choices: error.choices, listingCount: error.listingCount, ...error.successor ? { successor: error.successor } : {} }
    : {};
  return { input, status, listing: null, symbol: null, exchange: null, name: null, message: error.message, notes: null, hint, ...choice };
}

/**
 * Why a row was not added or removed, as its line's parentheses say it: the
 * listings to choose from after a choice it asks for ("Choose an exchange for
 * NEP: NEP:SET, NEP:XHAM"), and after them what became of the symbol.
 */
export function failedReason(row: SymbolRow, subject: string): string {
  const text = reason(row.message ?? "", subject);
  if (!row.choices?.length) return text;
  const more = (row.listingCount ?? row.choices.length) - row.choices.length;
  const listings = `${row.choices.map((choice) => choice.key).join(", ")}${more > 0 ? ` and ${more} more` : ""}`;
  return `${text}: ${listings}${row.successor ? `; ${row.successor}` : ""}`;
}

/** What a symbol's history says of the company that had it. */
interface SymbolHistory {
  /** Its line: "BRKL was Brookline Bancorp until 2025, now Beacon Financial: BBT". */
  note: string;
  /** The symbol that company trades as now. */
  successor: string | null;
  /** The day it left the symbol (YYYY-MM-DD). */
  left: string | null;
  /** Its name, when known. */
  company: string | null;
}

/** The history of a symbol's change or former issuer; null when it has neither. */
function successorOf(resolution: Pick<CliTicker, "change" | "formerIssuer">): SymbolHistory | null {
  const { change, formerIssuer } = resolution;
  const changeLine = tickerChangeLine(change);
  if (changeLine) return { note: changeLine, successor: change?.tradesAs ?? null, left: change?.changes[0]?.date ?? null, company: change?.issuer ?? null };
  return formerIssuer
    ? { note: formerIssuer.note, successor: formerIssuer.successor.symbol, left: formerIssuer.until, company: formerIssuer.name }
    : null;
}

/**
 * How recently another company may have left a symbol for its new holder to
 * need a choice: a list kept from then means that company. Earlier reuse
 * (FSBC, 2021) is added, its line saying who had it.
 */
const RECENT_REUSE_MS = 2 * 365 * 24 * 60 * 60_000;

/**
 * Whether a listing trades outside the US: on a venue in another country's
 * time zone (DFS:LSE), or, on one the app cannot place, in another currency
 * (GNTY:PSX in rupees). Coins and perpetual markets, on venues that keep UTC,
 * and currency pairs (USDJPY=X, quoted in yen) trade in no country.
 */
function isListedAbroad(ticker: TickerRecord): boolean {
  const venue = canonicalExchange(ticker.metadata.exchange);
  if (!venue || isCurrencyPairListing(ticker.metadata.ticker, venue)) return false;
  const zone = resolveExchangeTimeZone(venue);
  if (zone) return zone !== "UTC" && isVenueAbroad(venue);
  const currency = ticker.metadata.currency?.trim().toUpperCase();
  return !isUsSymbolVenue(venue) && !!currency && currency !== "USD";
}

/** A bare US-shaped symbol (JPM, BRK.B), not 7203 or RY.TO, which name a venue of their own. */
function bareUsShapedSymbol(resolution: Pick<CliTicker, "bareSymbol">): string | null {
  const symbol = resolution.bareSymbol;
  return symbol && tickerChangeSymbol(symbol) && !tickerHasListingSuffix(symbol) ? symbol : null;
}

type SymbolDeps = { store: TickerSource; dataProvider: DataProvider };

const NO_SAVED_ROWS = { loadTicker: async () => null, loadAllTickers: async () => [] };

/**
 * Whether a bare symbol also names a US listing: a US company had or has it
 * (its change history: DFS was Discover Financial Services), or it lists on
 * a US venue, by the venues the lookup saw or, when it asked none (a saved
 * row, read with no search), by search now, else by the symbol's own quote,
 * which names its US line first. When neither answers it counts as naming
 * one, so the match stays a choice.
 */
async function namesUsListing(resolution: CliTicker, deps: SymbolDeps): Promise<boolean> {
  if (resolution.change || resolution.formerIssuer) return true;
  if (resolution.otherVenues) return resolution.otherVenues.some((venue) => isUsSymbolVenue(venue));
  const symbol = resolution.bareSymbol!;
  // Search's listings, not the saved row it would answer with; none found (or search failed) says nothing.
  const venues = await listingVenues(symbol, { store: NO_SAVED_ROWS, dataProvider: deps.dataProvider })
    .catch(logFailure("cli.symbol-rows", "Read listing venues failed", []));
  if (venues.length > 0) return venues.some((venue) => isUsSymbolVenue(venue.exchange));
  const quote = await deps.dataProvider.getQuote(symbol, "").catch(logFailure("cli.symbol-rows", "Quote bare symbol failed", null));
  const venue = canonicalExchange(quote?.listingExchangeName || quote?.exchangeName);
  return !venue || isUsSymbolVenue(venue);
}

/**
 * Whether a bare symbol is stored on its listing abroad, still trading, and
 * that is all it names (`namesUsListing`): GARAN is added on BIST, saying so.
 */
async function listedOnlyAbroad(resolution: CliTicker, deps: SymbolDeps): Promise<boolean> {
  if (!bareUsShapedSymbol(resolution) || resolution.ended || !isListedAbroad(resolution.ticker)) return false;
  return !await namesUsListing(resolution, deps);
}

/** "GARAN has no US listing; it trades on BIST, in TRY.": the line an add says beside a symbol `listedOnlyAbroad`. */
function abroadOnlyNote(resolution: CliTicker): string {
  const { exchange, currency } = resolution.ticker.metadata;
  const unit = currency?.trim();
  return `${resolution.bareSymbol} has no US listing; it trades on ${exchangeLabel(exchange)}${unit ? `, in ${unit}` : ""}.`;
}

/**
 * What a bare symbol listed only abroad was more likely typed for: a
 * currency (MXN, mixi Inc in Stuttgart) or a US ticker one slip away (APPL,
 * Aptus Pharma in Mumbai, for AAPL). "APPL is one slip from AAPL (Apple
 * Inc.)" or "MXN is also a currency"; null when the symbol is likely meant as typed.
 */
async function meantInstead(symbol: string, deps: SymbolDeps): Promise<string | null> {
  if (symbol !== "USD" && /^[A-Z]{3}$/.test(symbol) && isCurrencyCode(symbol)) return `${symbol} is also a currency`;
  const suggestion = await suggestUsTicker(symbol, deps).catch(logFailure("cli.symbol-rows", "Suggest a US ticker failed", null));
  return suggestion ? `${symbol} is one slip from ${describeSuggestion(suggestion)}` : null;
}

/**
 * How a bare symbol matched abroad is settled: `abroad` when it is added
 * there, with its line, or `meant` when it is left for a choice as more
 * likely typed for something else. Both null for anything else, which
 * `choiceNeeded` decides.
 */
async function settleAbroad(resolution: CliTicker, deps: SymbolDeps): Promise<{ abroad: string | null; meant: string | null; onlyAbroad: boolean }> {
  if (!await listedOnlyAbroad(resolution, deps)) return { abroad: null, meant: null, onlyAbroad: false };
  const meant = await meantInstead(resolution.bareSymbol!, deps);
  return { abroad: meant ? null : abroadOnlyNote(resolution), meant, onlyAbroad: true };
}

/** Whether a YYYY-MM-DD day is within `ms` before `now`. */
function within(day: string | null, ms: number, now: number): boolean {
  const at = day ? Date.parse(day.slice(0, 10)) : Number.NaN;
  return Number.isFinite(at) && now - at <= ms;
}

/**
 * Why a symbol of an add that named no exchange is not stored as it matched:
 * the listing found stopped trading (NYCB:NYSE), it is a listing abroad while
 * the symbol also names a US one (DFS Furniture's DFS:LSE for DFS, Discover's
 * old symbol) or was likely typed for something else (`meantInstead`: APPL
 * for AAPL), or the company that had the symbol left it in
 * the last two years (BRKL, Brookline Bancorp's until 2025, now a fund's). The message
 * leads with what became of the company that held the symbol, when the
 * symbol's history says ("DFS was Discover Financial Services until 2025, now
 * Capital One Financial: COF"), whose symbol now is the successor offered; the
 * match is offered too. Null for a match stored as it is: a trading US
 * listing whose symbol changed hands longer ago (its row says so) or never,
 * a listing abroad that is all the symbol names (GARAN:BIST for GARAN, said
 * with `abroadOnlyNote`), or one whose input named its exchange; coins,
 * perpetual markets and currency pairs, which trade in no one country, too.
 */
function choiceNeeded(
  resolution: CliTicker,
  { onlyAbroad, meant }: { onlyAbroad: boolean; meant: string | null },
  now = Date.now(),
): { message: string; successor: string | null } | null {
  const symbol = bareUsShapedSymbol(resolution);
  if (!symbol) return null;
  const history = successorOf(resolution);
  const label = savedListingName(resolution.ticker).label;
  // A company that left lately: the match is another's, or that company's own line, still quoted.
  const recent = !!history?.successor && within(history.left, RECENT_REUSE_MS, now);
  const found = resolution.ended
    ?? (isListedAbroad(resolution.ticker) && (!onlyAbroad || meant)
      ? `${symbol} matched ${label}, a listing abroad${meant ? `; ${meant}` : ""}`
      : recent ? `${symbol} matched ${label}, ${sameCompany(resolution.ticker.metadata.name, history?.company) ? "that company's old line" : "another company's listing"}`
        : null);
  if (!found) return null;
  return { message: history ? `${history.note}; ${found}` : found, successor: history?.successor ?? null };
}

/** The plain no-match answer, which a "Not found" line already says. */
export const NO_MATCH = /^No ticker match found for /;

/**
 * "251 added, 5 already in the list, 43 not found: XXXXX, FAKE123; 3 need a
 * choice: DFS, PACW, FI; 2 not added: KHC, FITB; 1 repeat skipped." The first
 * count is always there, the others when there are any, and the symbols that
 * went nowhere are named so the list can be fixed.
 */
export function summarizeSymbolRows(rows: readonly SymbolRow[], verb: Verb, repeated: number): string {
  // An entry that is no symbol, or was not looked up, is named as it was written: `$$$`, `philip morris intl`.
  const inputs = (status: SymbolStatus) => rows.filter((row) => row.status === status)
    .map((row) => status === "not_a_symbol" || status === "not_looked_up" ? row.input.trim() : symbolInputKey(row.input));
  const counts = SETTLED[verb]
    .map(([status, word], index) => ({ count: inputs(status).length, word, index }))
    .filter(({ count, index }) => index === 0 || count > 0)
    .map(({ count, word }) => `${count} ${word}`);
  const missing = inputs("not_found");
  if (missing.length > 0) counts.push(`${missing.length} not found: ${missing.join(", ")}`);
  const groups = [counts.join(", ")];
  const choices = inputs("needs_choice");
  if (choices.length > 0) groups.push(`${choices.length} need${choices.length === 1 ? "s" : ""} a choice: ${choices.join(", ")}`);
  const failed = inputs("failed");
  if (failed.length > 0) groups.push(`${failed.length} not ${verb === "add" ? "added" : "removed"}: ${failed.join(", ")}`);
  const unanswered = inputs("not_looked_up");
  if (unanswered.length > 0) groups.push(`${unanswered.length} not looked up: ${unanswered.join(", ")}`);
  const junk = inputs("not_a_symbol");
  if (junk.length > 0) {
    groups.push(`${junk.length} not ${junk.length === 1 ? "a symbol" : "symbols"}: ${junk.join(junk.some((input) => input.includes(",")) ? "; " : ", ")}`);
  }
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

type AddTicker = (ticker: TickerRecord) => { changed: boolean; ticker: TickerRecord };

/** One symbol of an add, decided: its row, and the error it failed with, if it did. */
interface AddOutcome {
  row: SymbolRow;
  error: Error | null;
}

/**
 * What one looked-up symbol of an add comes to, the same for a list and a
 * symbol alone: added (or already there), left for a choice (`choiceNeeded`,
 * or nothing lists under it while its company trades as another), or failed.
 * A match left for a choice is dropped from `staged` unless `added` holds it,
 * a listing an earlier symbol of the same add went to.
 */
async function settleAdd(
  input: string,
  lookup: CliTickerResolution,
  staged: StagedTickerRepository,
  dataProvider: DataProvider,
  add: AddTicker,
  added: Set<string>,
): Promise<AddOutcome> {
  if (lookup.error) {
    const { error } = lookup;
    // Nothing lists as the symbol, but its company trades as another now: that is the choice.
    return error instanceof TickerNotFoundError && error.successor
      ? { row: { ...failedRow(input, error, "needs_choice"), tradesAs: error.successor }, error }
      : { row: failedRow(input, error), error };
  }
  const abroad = await settleAbroad(lookup, { store: staged, dataProvider });
  const choice = choiceNeeded(lookup, abroad);
  if (choice) {
    // The lookup saved the listing it matched; one that is in no list of this run is not kept.
    if (!added.has(lookup.ticker.metadata.ticker)) staged.discard(lookup.ticker.metadata.ticker);
    return { row: listingRow(input, "needs_choice", lookup.ticker, {
      notes: lookup.notes, readAs: lookup.readAs, extra: { message: choice.message, tradesAs: choice.successor },
    }), error: null };
  }
  // Read back: an earlier symbol may have added this listing already.
  const current = await staged.loadTicker(lookup.ticker.metadata.ticker) ?? lookup.ticker;
  let result: ReturnType<AddTicker>;
  try {
    result = add(current);
  } catch (caught) {
    const error = caught instanceof Error ? caught : new Error(String(caught));
    return { row: failedRow(input, error), error };
  }
  if (result.changed) await staged.saveTicker(result.ticker);
  added.add(result.ticker.metadata.ticker);
  // Another company had the symbol: the row says which, and what it trades as now.
  const history = successorOf(lookup);
  return { row: listingRow(input, result.changed ? "added" : "already_listed", result.ticker, {
    notes: lookup.notes, ended: lookup.ended, hint: lookup.coinNote, readAs: lookup.readAs,
    extra: { ...history ? { changeNote: history.note, tradesAs: history.successor } : {}, ...abroad.abroad ? { abroad: abroad.abroad } : {} },
  }), error: null };
}

/**
 * Resolves the symbols several at a time and adds each that resolves; one that
 * does not never stops the rest, and one whose match needs a choice
 * (`settleAdd`) is left out, with nothing of it saved. Every change is
 * written once, at the end, or not at all for a dry run.
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
  dryRun = false,
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
  /** Work out every row but save nothing. */
  dryRun?: boolean;
  /** May throw to refuse the listing (an alias of a holding in two records); that symbol fails alone. */
  add: AddTicker;
}): Promise<SymbolRow[]> {
  const staged = new StagedTickerRepository(store);
  const rejected = new Map(symbols.map((input) => [input, reject?.(input) ?? null] as const));
  const resolutions = await resolveTickersForCli(symbols.filter((input) => !rejected.get(input)), staged, dataProvider, exchange, { onRetry, retry, askWhenAmbiguous });
  const resolved = new Map(resolutions.map((resolution) => [resolution.input, resolution] as const));
  const rows: SymbolRow[] = [];
  // Listings a symbol of this list was added to, which a later symbol's choice must not drop.
  const added = new Set<string>();
  for (const input of symbols) {
    const refusal = rejected.get(input);
    const resolution = resolved.get(input);
    if (refusal || !resolution) {
      rows.push(failedRow(input, refusal ?? new Error("Not looked up.")));
      continue;
    }
    const { row } = await settleAdd(input, resolution, staged, dataProvider, add, added);
    rows.push(resolution.error && row.status !== "needs_choice" && failure ? failedRow(input, failure(resolution.error)) : row);
  }
  if (!dryRun) await staged.commit();
  return suggest ? withSuggestions(rows, staged, dataProvider) : rows;
}

/**
 * One symbol added as a symbol of a list is (`settleAdd`), for `watchlist add`
 * and `portfolio add` given one: a match a list would leave for a choice is
 * left for it alone too, and nothing of it saved. The single add fails fast
 * where a list waits and looks again: a refused lookup is the error, to retry.
 * The lookup comes back with the row, for what the single add prints beside
 * it, and so does the error of one that failed.
 */
export async function addSymbol(
  input: string,
  { exchange, store, dataProvider, reject, retry, dryRun = false, add }: {
    exchange: string | undefined;
    store: TickerSource;
    dataProvider: DataProvider;
    reject?: (input: string) => Error | null;
    retry?: CliTickerOptions["retry"];
    dryRun?: boolean;
    add: AddTicker;
  },
): Promise<AddOutcome & { lookup: CliTicker | null }> {
  const refusal = reject?.(input);
  if (refusal) return { row: failedRow(input, refusal), error: refusal, lookup: null };
  const staged = new StagedTickerRepository(store);
  let lookup: CliTickerResolution;
  try {
    // A list waits for the symbol's history, which decides whether the match is stored; so does one symbol.
    lookup = { input, ...await resolveCliTicker(input, staged, dataProvider, exchange, { retry, changeGraceMs: LOOKUP_TIMEOUT_MS }) };
  } catch (caught) {
    lookup = { input, error: caught instanceof Error ? caught : new Error(String(caught)) };
  }
  const outcome = await settleAdd(input, lookup, staged, dataProvider, add, new Set());
  if (!dryRun) await staged.commit();
  return { ...outcome, lookup: lookup.error ? null : lookup };
}

/**
 * How a typed symbol the command bar adds on its own is decided, as a symbol
 * of a pasted list is (`settleAdd`): a needs-choice row when it would not be
 * stored as it matched, else the row it would add, which says when it is
 * listed only abroad; null when nothing was looked up. Nothing is saved.
 */
export async function typedSymbolChoice(input: string, store: TickerSource, dataProvider: DataProvider): Promise<SymbolRow | null> {
  const symbol = input.trim().toUpperCase();
  // Only a bare US-shaped symbol can need one (`choiceNeeded`); anything else is not looked up twice.
  if (!tickerChangeSymbol(symbol) || tickerHasListingSuffix(symbol)) return null;
  const staged = new StagedTickerRepository(store);
  let lookup: CliTickerResolution;
  try {
    lookup = { input: symbol, ...await resolveCliTicker(symbol, staged, dataProvider, undefined, { askWhenAmbiguous: true, changeGraceMs: LOOKUP_TIMEOUT_MS }) };
  } catch (caught) {
    lookup = { input: symbol, error: caught instanceof Error ? caught : new Error(String(caught)) };
  }
  const { row } = await settleAdd(symbol, lookup, staged, dataProvider, (ticker) => ({ changed: false, ticker }), new Set());
  return row;
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
