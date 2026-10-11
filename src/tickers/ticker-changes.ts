import type { DataProvider } from "../types/data-provider";
import type { Quote } from "../types/financials";
import type { TickerChangeHop, TickerChanges } from "../types/ticker-changes";
import { isCryptoPairSymbol } from "../utils/crypto-pair";
import { canonicalExchange, isUsListingExchange } from "../utils/exchanges";
import { sameCompany, shortCompanyName } from "./company-name";

/**
 * A symbol that changed (FB became META), as data for `--json`. `moved`: the
 * issuer that held the symbol left it, so whatever lists under it now is a
 * different security, and commands print `note`. `formerly`: the symbol's
 * holder traded under another symbol before (METV was META); the user got
 * what they typed, so nothing is printed.
 */
export interface TickerChange {
  symbol: string;
  kind: "moved" | "formerly";
  /** The change in one line; printed for `moved` only (`tickerChangeLine`). */
  note: string;
  /** Each change, oldest first. */
  changes: TickerChangeHop[];
  /** moved: the symbol the issuer that left trades as now. */
  tradesAs?: string;
  /** moved: that issuer's name, when known. */
  issuer?: string | null;
  /** moved: what lists under the symbol today; null when nothing does. */
  listed?: string | null;
}

/** What trades under the symbol now, as a command saw it: its name, and when it last traded. */
export interface CurrentListing {
  name?: string | null;
  lastTraded?: number | null;
}

/** Where changes come from: the market data provider, which asks Gloom Cloud. */
type TickerChangeSource = Pick<DataProvider, "getTickerChanges">;

/** A lookup in flight: `settle` waits a little more for it, then gives up and stops the request. */
export interface TickerChangeLookup {
  settle(graceMs?: number): Promise<TickerChanges | null>;
}

/** How long a command waits for a note once its own answer is ready. */
const TICKER_CHANGE_GRACE_MS = 200;
/** The longest a lookup runs, for a caller that keeps waiting. */
const LOOKUP_TIMEOUT_MS = 5_000;
/** A failed lookup is tried again after this, so a note comes back with the service. */
const RETRY_FAILED_AFTER_MS = 60_000;
/** A symbol the change history can hold: letters and digits, and a share class (BRK.B). */
const PLAIN_SYMBOL = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z0-9]{1,4})?$/;

interface Entry {
  promise: Promise<TickerChanges | null>;
  controller: AbortController;
  done: boolean;
  failedAt: number | null;
}

/** One session's answers per source: a symbol is looked up once. */
const sessions = new WeakMap<TickerChangeSource, Map<string, Entry>>();
const NONE: TickerChangeLookup = { settle: async () => null };

/** A venue the change history is about: none named, a US exchange, or US over-the-counter. */
export function isUsSymbolVenue(exchange?: string | null): boolean {
  const venue = canonicalExchange(exchange ?? "");
  return !venue || isUsListingExchange(venue) || venue.startsWith("OTC");
}

/**
 * The symbol a change lookup is for: a plain one, bare or on a US venue. The
 * history is of US listings; SAN:EPA, a future or a pair has none.
 */
function tickerChangeSymbol(symbol: string, exchange?: string | null): string | null {
  const plain = symbol.trim().toUpperCase();
  return PLAIN_SYMBOL.test(plain) && !isCryptoPairSymbol(plain) && isUsSymbolVenue(exchange) ? plain : null;
}

function readPayload(value: unknown): TickerChanges | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<TickerChanges>;
  if (typeof payload.symbol !== "string" || !Array.isArray(payload.changes)) return null;
  return {
    symbol: payload.symbol,
    moved: payload.moved && Array.isArray(payload.moved.hops) && payload.moved.hops.length > 0 ? payload.moved : null,
    formerly: Array.isArray(payload.formerly) && payload.formerly.length > 0 ? payload.formerly : null,
    listedName: typeof payload.listedName === "string" && payload.listedName.trim() ? payload.listedName : null,
    changes: payload.changes,
  };
}

function entryFor(symbol: string, source: TickerChangeSource & Required<TickerChangeSource>): Entry {
  let session = sessions.get(source);
  if (!session) {
    session = new Map();
    sessions.set(source, session);
  }
  const cached = session.get(symbol);
  if (cached && (cached.failedAt === null || Date.now() - cached.failedAt < RETRY_FAILED_AFTER_MS)) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  const entry: Entry = { promise: Promise.resolve(null), controller, done: false, failedAt: null };
  entry.promise = source.getTickerChanges(symbol, { signal: controller.signal })
    .then(readPayload)
    .catch(() => {
      entry.failedAt = Date.now();
      return null;
    })
    .finally(() => {
      entry.done = true;
      clearTimeout(timer);
    });
  session.set(symbol, entry);
  return entry;
}

/**
 * Starts looking up a symbol's changes, beside the request that answers the
 * command. Fails soft: offline, refused or slow means no note, and `settle`
 * never holds the command up by more than its grace.
 */
export function startTickerChangeLookup(
  source: TickerChangeSource | null | undefined,
  symbol: string,
  exchange?: string | null,
): TickerChangeLookup {
  const plain = tickerChangeSymbol(symbol, exchange);
  if (!plain || !source?.getTickerChanges) return NONE;
  const entry = entryFor(plain, source as Required<TickerChangeSource>);
  return {
    async settle(graceMs = TICKER_CHANGE_GRACE_MS) {
      if (entry.done) return entry.promise;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), graceMs);
      });
      const answer = await Promise.race([entry.promise, late]).finally(() => clearTimeout(timer));
      if (answer !== "late") return answer;
      // Given up: stop the request so nothing is left waiting on it.
      entry.controller.abort();
      return null;
    },
  };
}

/** What a quote says trades under its symbol: the security's name and its last trade. */
export function quotedListing(quote: Pick<Quote, "name" | "lastTradeTime" | "lastUpdated">): CurrentListing {
  const last = Math.max(...[quote.lastTradeTime, quote.lastUpdated].filter((time): time is number => Number.isFinite(time)));
  return { name: quote.name?.trim() || null, lastTraded: last > 0 ? last : null };
}

function day(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/** "to META on 2022-06-09, then MMATQ on 2024-08-21": each later hop of a chain. */
function laterHops(hops: readonly TickerChangeHop[], lead: string): string {
  return hops.slice(1).map((hop) => `, then ${lead}${hop.to} on ${hop.date}`).join("");
}

/**
 * The line a command prints beside a symbol that changed: only when its
 * company left it. Typing the symbol a company renamed into (META, METV) gets
 * what was typed, so nothing extra.
 */
export function tickerChangeLine(change: TickerChange | null | undefined): string | null {
  return change?.kind === "moved" ? change.note : null;
}

/**
 * The note for a symbol's changes. `current` is what the command found
 * trading under the symbol: null when nothing does, left out when it did not
 * look. A quote that stopped before the change, or that names the issuer that
 * left, is that issuer's old line rather than a new listing.
 *
 * "FB now lists ProShares S&P 500 Dynamic Daily Buffer ETF; Meta Platforms trades as META (changed 2022-06-09)"
 * "FB changed to META on 2022-06-09"
 * "METV was META until 2022-01-31" (data only: `tickerChangeLine` prints none)
 */
export function describeTickerChange(
  typed: string,
  payload: TickerChanges | null,
  current?: CurrentListing | null,
): TickerChange | null {
  if (!payload) return null;
  const symbol = typed.trim().toUpperCase();
  const { moved, formerly } = payload;
  if (moved) {
    const [first] = moved.hops;
    if (!first) return null;
    const issuer = moved.name?.trim() ? shortCompanyName(moved.name) : null;
    const stillTheIssuer = !!current && (
      (current.lastTraded != null && current.lastTraded < day(first.date))
      || (!!current.name && !!moved.name && sameCompany(current.name, moved.name))
    );
    const listedHere = current === undefined ? payload.listedName !== null : current !== null && !stillTheIssuer;
    const listed = listedHere ? current?.name?.trim() || payload.listedName || "another security" : null;
    const when = moved.hops.length === 1
      ? `changed ${first.date}`
      : `changed to ${first.to} on ${first.date}${laterHops(moved.hops, "")}`;
    const note = listed
      ? `${symbol} now lists ${listed}; ${issuer ?? `the former ${symbol}`} trades as ${moved.symbol} (${when})`
      : `${symbol} changed to ${first.to} on ${first.date}${laterHops(moved.hops, "to ")}`;
    return { symbol, kind: "moved", note, changes: moved.hops, tradesAs: moved.symbol, issuer, listed };
  }
  if (formerly) {
    const [latest, ...earlier] = formerly;
    if (!latest) return null;
    const note = `${symbol} was ${latest.from} until ${latest.date}${earlier.map((hop) => `, and ${hop.from} until ${hop.date}`).join("")}`;
    return { symbol, kind: "formerly", note, changes: [...formerly].reverse() };
  }
  return null;
}
