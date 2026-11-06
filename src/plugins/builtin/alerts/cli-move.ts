// `alerts add` for moves from the previous close: one symbol (`alerts add
// GBPUSD=X moves 0.5%`), several (`alerts add HSBA.L BARC.L down 3%`), or
// every listing of a watchlist (`alerts add --watchlist Book up 3%`), each an
// alert of its own, added in one write with one summary.
import type { MarketContext } from "../../../cli/types";
import type { Quote } from "../../../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { chunked, mapWithConcurrency } from "../../../utils/concurrency";
import type { QuoteBatchResult } from "../../../types/data-provider";
import { findCollection } from "../portfolio-list/cli/render";
import { alertListing } from "./format";
import { createAlert, sameLevelRule } from "./alert-engine";
import { moveBasisText, moveCondition, movePercentText, moveReached, moveRuleWords, parseMovePercent } from "./move";
import { moveQuoteFields } from "./quotes";
import type { AlertCondition, AlertRule } from "./types";

/** Listings quoted in one request: as many as a signed-out caller's batch may read. */
const QUOTE_BATCH_SIZE = 100;

/** The most alerts one command adds: a pasted book of a few hundred names fits, a whole index does not. */
export const MAX_BULK_ALERTS = 500;

/** What `alerts add` was asked for when it names a move. */
export interface MoveAddRequest {
  kind: "move";
  /** As typed; empty with `--watchlist`. */
  symbols: string[];
  condition: AlertCondition;
  /** The move in percent, unsigned. */
  percent: number;
  /** How a level with a sign was read (`below -3%` as down 3%), said beside the alerts added. */
  readAs?: string;
}

const MOVE_EXAMPLE = "alerts add GBPUSD=X moves 0.5%, alerts add AZN.L down 3%, or alerts add --watchlist Book up 3%";

/**
 * A move as `alerts add` takes it: the symbols, then `moves`, `up` or `down`
 * and a percent (`moves 0.5%`, `down 3`). A level written with a signed
 * percent is that move (`below -3%` is down 3%, `above +2%` up 2%); one with
 * an unsigned percent (`below 3%`) is refused, as a price level is a price.
 * With `watchlist` the symbols come from the list, so none is typed. Null
 * for any other form; throws a message naming what it takes.
 */
export function parseMoveAddArgs(args: readonly string[], watchlist: boolean): MoveAddRequest | null {
  if (args.length < 2) return null;
  const word = args.at(-2)!;
  const typed = args.at(-1)!;
  let condition = moveCondition(word);
  let readAs: string | undefined;
  if (condition) {
    const percent = parseMovePercent(typed);
    if (percent == null) throw new Error(`A move is a percent from the previous close, above 0 and up to 100, not "${typed}": ${MOVE_EXAMPLE}.`);
    return withSymbols(args.slice(0, -2), { kind: "move", symbols: [], condition, percent }, watchlist);
  }
  // A level with a percent is read only as `<symbol> above|below <percent>`: longer forms are other kinds (iv above 50%).
  const level = word.toLowerCase();
  // Only a percent written as one (`-3%`, `3%`): any other text (`0,01%`) is refused as the price it is not.
  if ((level !== "above" && level !== "below") || !/^[+-]?\s*(\d+(\.\d+)?|\.\d+)\s*%$/.test(typed.trim()) || args.length !== (watchlist ? 2 : 3)) return null;
  const signed = /^([+-])\s*(\d+(?:\.\d+)?|\.\d+)\s*%$/.exec(typed.trim());
  const percent = signed ? parseMovePercent(signed[2]) : null;
  const direction = signed?.[1] === "-" ? "below" : signed?.[1] === "+" ? "above" : null;
  if (percent == null || direction !== level) {
    const symbol = args.length > 2 ? args[0] : "AZN.L";
    throw new Error(`A price level is a price, not "${typed}". For a move from the previous close: alerts add ${symbol} ${level === "below" ? "down" : "up"} ${typed.replace(/^[+-]/, "")}.`);
  }
  condition = direction === "below" ? "below" : "above";
  readAs = `Read "${word} ${typed}" as ${condition === "below" ? "down" : "up"} ${percent}% from the previous close.`;
  return withSymbols(args.slice(0, -2), { kind: "move", symbols: [], condition, percent, readAs }, watchlist);
}

function withSymbols(symbols: string[], request: MoveAddRequest, watchlist: boolean): MoveAddRequest {
  if (watchlist && symbols.length > 0) throw new Error(`Name symbols or --watchlist, not both: alerts add ${symbols.join(" ")} ${moveRuleWords({ ...request, targetPrice: request.percent })}, or alerts add --watchlist <name> ${moveRuleWords({ ...request, targetPrice: request.percent })}.`);
  if (!watchlist && symbols.length === 0) throw new Error(`Name a symbol or a watchlist: ${MOVE_EXAMPLE}.`);
  return { ...request, symbols };
}

/** One symbol of a move add: the listing and quote it was read as, or why it was not. */
export interface MoveListing {
  input: string;
  listing?: { symbol: string; exchange?: string };
  quote?: Quote;
  /** Why no alert was made for it. */
  error?: string;
  /** What it was read as (`Read "VOD LN" as VOD:LSE.`). */
  notes?: string[];
}

/** The listings of a watchlist, read from its saved rows; fails naming the lists there are when none is called that. */
export async function watchlistListings(
  market: Pick<MarketContext, "config" | "store">,
  name: string,
  fail: (message: string, details?: string) => never,
): Promise<{ name: string; listings: Array<{ input: string; symbol: string; exchange: string }> }> {
  const collection = findCollection(market.config, name);
  if (!collection || collection.kind !== "watchlist") {
    const lists = market.config.watchlists.map((watchlist) => watchlist.name);
    return fail(`Watchlist "${name}" was not found.`, lists.length ? `Watchlists: ${lists.join(", ")}` : "Make one with gloom watchlist create <name>.");
  }
  const tickers = (await market.store.loadAllTickers()).filter((ticker) => ticker.metadata.watchlists.includes(collection.id));
  return {
    name: collection.name,
    listings: tickers.map((ticker) => {
      const key = parsePublicTickerKey(ticker.metadata.ticker);
      const exchange = canonicalExchange(key.exchange || ticker.metadata.exchange || "");
      // Named as the list shows it, with its venue: 7203:JPX.
      return { input: exchange && !key.exchange ? `${key.symbol}:${exchange}` : ticker.metadata.ticker, symbol: key.symbol, exchange };
    }),
  };
}

/** Quotes for saved listings, asked in batches; a listing without one says why. */
export async function quoteSavedListings(
  market: Pick<MarketContext, "dataProvider">,
  listings: ReadonlyArray<{ input: string; symbol: string; exchange: string }>,
): Promise<MoveListing[]> {
  const targets = listings.map((listing) => ({ symbol: listing.symbol, exchange: listing.exchange }));
  // A hundred listings a request, as many as a signed-out caller's batch may read, one after another.
  const results: QuoteBatchResult[] = [];
  for (const chunk of chunked(targets, QUOTE_BATCH_SIZE)) {
    results.push(...await market.dataProvider.getQuotesBatch(chunk).catch((error: unknown) => chunk.map((target) => ({ target, quote: null, error }))));
  }
  const byTarget = new Map(results.map((result) => [result.target, result] as const));
  return listings.map((listing, index) => {
    const result = byTarget.get(targets[index]!) ?? results.find((entry) => entry.target.symbol === listing.symbol && (entry.target.exchange ?? "") === listing.exchange);
    // Kept as the watchlist keeps it (7203:JPX), as a price alert keeps the listing `quote` prints.
    if (result?.quote) return { input: listing.input, listing: { symbol: listing.input, ...listing.exchange ? { exchange: listing.exchange } : {} }, quote: result.quote };
    if (result?.error instanceof Error && result.error.message) return { input: listing.input, error: result.error.message };
    const reason = result?.error instanceof Error ? result.error.message : typeof result?.error === "string" ? result.error : "no quote";
    return { input: listing.input, error: reason };
  });
}

/** Reads typed symbols several at a time, each as `quote` reads it; one that fails says why and never stops the rest. */
export function quoteTypedSymbols(
  symbols: readonly string[],
  read: (symbol: string) => Promise<{ listing: { key: string; exchange: string }; quote: Quote; notes: string[] }>,
): Promise<MoveListing[]> {
  return mapWithConcurrency(symbols, 8, async (input): Promise<MoveListing> => {
    try {
      const { listing, quote, notes } = await read(input);
      // Kept as a price alert keeps it: the listing `quote` prints for the symbol.
      return { input, listing: { symbol: listing.key, ...listing.exchange ? { exchange: canonicalExchange(listing.exchange) } : {} }, quote, notes };
    } catch (error) {
      return { input, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

/** Inputs once each, case aside, the first `MAX_BULK_ALERTS` of them; how many repeats were dropped and how many were left out. */
export function uniqueInputs<T extends { input: string }>(inputs: readonly T[]): { inputs: T[]; repeats: number; leftOut: number } {
  const seen = new Set<string>();
  const unique = inputs.filter((entry) => {
    const key = entry.input.trim().toUpperCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { inputs: unique.slice(0, MAX_BULK_ALERTS), repeats: inputs.length - unique.length, leftOut: Math.max(0, unique.length - MAX_BULK_ALERTS) };
}

/** What a move add came to: the alerts to save, and each symbol that made none. */
export interface MovePlan {
  added: AlertRule[];
  /** Symbols whose alert was there already (the same listing, move and direction), with that alert. */
  existing: Array<{ input: string; alert: AlertRule }>;
  /** Symbols that name a listing another symbol of the same command made the alert for (7203.T beside `7203 JP`), with it. */
  sameListing: Array<{ input: string; alert: AlertRule }>;
  failed: Array<{ input: string; error: string }>;
}

/**
 * The alerts a move add makes, one per listing, with its first reading from
 * the quote it was read on; the same rule twice (7203.T and `7203 JP`, or a
 * rule already saved) is one alert.
 */
export function planMoveAlerts(request: MoveAddRequest, listings: readonly MoveListing[], saved: readonly AlertRule[], now = Date.now()): MovePlan {
  const plan: MovePlan = { added: [], existing: [], sameListing: [], failed: [] };
  for (const entry of listings) {
    if (!entry.listing || !entry.quote) {
      plan.failed.push({ input: entry.input, error: entry.error ?? "no quote" });
      continue;
    }
    const alert: AlertRule = {
      ...createAlert(entry.listing.symbol, request.condition, request.percent, entry.listing.exchange),
      move: true,
      ...moveQuoteFields(entry.quote, now),
    };
    const savedRule = saved.find((other) => sameLevelRule(other, alert));
    const made = savedRule ? undefined : plan.added.find((other) => sameLevelRule(other, alert));
    if (savedRule) plan.existing.push({ input: entry.input, alert: savedRule });
    else if (made) plan.sameListing.push({ input: entry.input, alert: made });
    else plan.added.push(alert);
  }
  return plan;
}

/** Listings a bulk add's one log entry names before "and N more". */
const LOGGED_LISTINGS = 3;

/**
 * A bulk move add as the alert log keeps it, one entry for all its alerts:
 * `109 move alerts up 3.00% on Book's listings: 1605:JPX, 2413:JPX, 2914:JPX
 * and 106 more`.
 */
export function bulkMoveLogRule(added: readonly AlertRule[], watchlist?: string): { kind: string; ruleId: string; rule: string } {
  const listings = added.slice(0, LOGGED_LISTINGS).map((alert) => alertListing(alert));
  const more = added.length > LOGGED_LISTINGS ? ` and ${added.length - LOGGED_LISTINGS} more` : "";
  return {
    kind: "move", ruleId: added[0]?.id ?? "",
    rule: `${added.length} move alerts ${moveRuleWords(added[0]!)}${watchlist ? ` on ${watchlist}'s listings` : ""}: ${listings.join(", ")}${more}`,
  };
}

/** How a move rule reaches you, as docs/usage.md states it: only the running app reads moves. */
export const MOVE_REARM = "once a session, armed again for the next one";

/** "now -0.38% vs Thu 5 Nov close", and that it goes off at the next check when the move is there already. */
export function moveNowText(alert: AlertRule, now = Date.now()): string | null {
  const percent = alert.lastCheckedPrice;
  if (percent == null || !Number.isFinite(percent)) return null;
  const reached = moveReached(alert, percent) ? ", so it goes off at the app's next check" : "";
  return `now ${movePercentText(percent)} ${moveBasisText(alert.lastMoveBasis, now)}${reached}`;
}

/** "LSE 120, JPX 100, NYSE 3": how many alerts were added on each venue, most first. */
export function venueCounts(alerts: readonly AlertRule[]): string {
  const counts = new Map<string, number>();
  for (const alert of alerts) {
    const venue = canonicalExchange(alert.exchange || alert.lastQuoteExchange || "") || "other";
    counts.set(venue, (counts.get(venue) ?? 0) + 1);
  }
  return [...counts].sort((left, right) => right[1] - left[1]).map(([venue, count]) => `${count} ${venue === "other" ? "other" : venue}`).join(", ");
}
