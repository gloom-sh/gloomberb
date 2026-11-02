import type { StatItem } from "../../../components";
import type { DataProvider } from "../../../types/data-provider";
import type { HeadlessPaneEntry } from "../../../types/headless";
import { loadEarningsCalendar } from "../earnings/data/cache";
import { optionSpread } from "../options/market-reference";
import { newYorkDay, resolveListingEvents, upcomingReportDate } from "../shared/earnings-calendar";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { formatHedgePrice } from "./hedge";
import { amountUnit, exportPercent, UNKNOWN_CURRENCY, type ScenarioPosition } from "./model";
import { logFailure } from "../../../utils/log-failure";

/**
 * A cash-secured put (docs/research-data.md#cash-secured-put): one short put
 * with the cash to buy the shares at the strike set aside. Figures, for the
 * position as entered:
 *
 * - cash secured = strike x multiplier x contracts
 * - premium received = entry price x multiplier x contracts; a `--strategy csp`
 *   seed enters at the quote midpoint
 * - yield on cash = premium / cash secured
 * - annualised yield = yield on cash x 365 / days to expiry (simple, not compounded)
 * - the same premium and yields at the bid, the price a sell order fills at
 *   without crossing the spread, when the put has a two-sided quote
 * - spread = ask - bid, and as a percent of the midpoint
 * - out of the money = (spot - strike) / spot, against the scenario's spot
 * - break-even = strike - entry price
 * - days to expiry = calendar days from the valuation date in New York to the expiry date
 * - earnings before expiry: yes when the next report is on or before the expiry date,
 *   no when it is after, unknown when the calendar has no upcoming date or could not be read
 */
export interface CashSecuredPut {
  currency: string;
  strike: number;
  /** Expiry calendar date, YYYY-MM-DD. */
  expiry: string;
  contracts: number;
  multiplier: number;
  /** Per share: what the put is sold at. */
  price: number;
  /** "mid" when a strategy seed entered the put at its quote midpoint, else the entry price as typed. */
  priceBasis: "mid" | "entry";
  cashSecured: number;
  premium: number;
  /** Premium over cash secured, as a fraction. */
  yieldOnCash: number;
  /** Null on the expiry day, when there is no day to annualise over. */
  annualizedYield: number | null;
  /** The put's two-sided quote and what selling at its bid yields; null without one. */
  quote: CspQuote | null;
  daysToExpiry: number;
  /** Valuation date in New York, YYYY-MM-DD. */
  valuationDate: string;
  spot: number;
  /** What the spot is: `implied by option quotes`, `typed`, `last price`. */
  spotBasis: string;
  /** (spot - strike) / spot as a fraction; negative when the put is in the money. */
  outOfTheMoney: number | null;
  breakEven: number;
  earnings: CspEarnings;
}

interface CspQuote {
  bid: number;
  ask: number;
  /** ask - bid, per share. */
  spread: number;
  /** The spread over the midpoint, as a fraction. */
  spreadOfMid: number;
  /** Premium at the bid, for every contract. */
  bidPremium: number;
  bidYieldOnCash: number;
  /** Null on the expiry day. */
  bidAnnualizedYield: number | null;
}

export interface CspEarnings {
  /** The next report date, YYYY-MM-DD, or null when none is published. */
  date: string | null;
  /** Null is unknown: no upcoming date to compare. */
  beforeExpiry: boolean | null;
  /** The earnings calendar could not be read, so there may be a date it did not give. */
  unavailable?: true;
}

/**
 * What `loadNextEarningsDate` answers when the earnings calendar could not be
 * read, in place of a date. Unlike null (no date published) it is reported as
 * unavailable. A string, so a capture can keep it in the pane's settings.
 */
export const EARNINGS_CALENDAR_UNAVAILABLE = "calendar-unavailable";

const DAY_MS = 86_400_000;
const newYorkDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

/** The calendar date of a moment in New York, YYYY-MM-DD. */
function newYorkCalendarDate(time: number): string {
  return newYorkDate.format(time);
}

/** The valuation date in New York, and the calendar days from it to `expiry` (YYYY-MM-DD), 0 once it is reached. */
export function calendarDaysToExpiry(asOf: number, expiry: string): { valuationDate: string; daysToExpiry: number } {
  const valuationDate = newYorkCalendarDate(asOf);
  return { valuationDate,
    daysToExpiry: Math.max(0, Math.round((Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${valuationDate}T00:00:00Z`)) / DAY_MS)) };
}

/** Whether the next report falls before the put expires; unknown without an upcoming date or a calendar to read one from. */
export function earningsBeforeExpiry(earningsDate: string | null | undefined, valuationDate: string, expiry: string): CspEarnings {
  if (earningsDate === EARNINGS_CALENDAR_UNAVAILABLE) return { date: null, beforeExpiry: null, unavailable: true };
  if (!earningsDate || !/^\d{4}-\d{2}-\d{2}$/.test(earningsDate) || earningsDate < valuationDate) return { date: null, beforeExpiry: null };
  return { date: earningsDate, beforeExpiry: earningsDate <= expiry };
}

/** What selling at `price` per share earns on the cash secured: the one yield calculation, at the entry price and at the bid alike. */
function putYield(price: number, cashSecured: number, sharesSold: number, daysToExpiry: number) {
  const premium = Math.round(price * sharesSold * 1e6) / 1e6;
  const yieldOnCash = premium / cashSecured;
  return { premium, yieldOnCash, annualizedYield: daysToExpiry > 0 ? yieldOnCash * 365 / daysToExpiry : null };
}

/**
 * The position as a cash-secured put, or null when it is not one short put.
 * `spotBasis` names the spot the out-of-the-money distance is read against;
 * `quote` is the put's bid and ask, for a put seeded from the chain
 * (`seededLegQuotes`).
 */
export function cashSecuredPut(
  position: ScenarioPosition, spotBasis: string, earningsDate: string | null | undefined,
  quote?: { bid: number; ask: number } | null,
): CashSecuredPut | null {
  const [leg] = position.legs;
  if (position.legs.length !== 1 || !leg || leg.side !== "put" || leg.quantity >= 0 || position.underlying) return null;
  const contracts = -leg.quantity;
  const expiry = new Date(leg.expiration * 1000).toISOString().slice(0, 10);
  const { valuationDate, daysToExpiry } = calendarDaysToExpiry(position.asOf, expiry);
  const cashSecured = leg.strike * leg.multiplier * contracts;
  const sharesSold = leg.multiplier * contracts;
  const atEntry = putYield(leg.price, cashSecured, sharesSold, daysToExpiry);
  const spread = quote ? optionSpread(quote) : null;
  let bidQuote: CspQuote | null = null;
  if (quote && spread?.kind === "two-sided") {
    const atBid = putYield(quote.bid, cashSecured, sharesSold, daysToExpiry);
    bidQuote = { bid: quote.bid, ask: quote.ask, spread: spread.spread, spreadOfMid: spread.percentOfMid / 100,
      bidPremium: atBid.premium, bidYieldOnCash: atBid.yieldOnCash, bidAnnualizedYield: atBid.annualizedYield };
  }
  return {
    currency: position.currency, strike: leg.strike, expiry, contracts, multiplier: leg.multiplier,
    price: leg.price, priceBasis: leg.priceSource === "mid" ? "mid" : "entry",
    cashSecured, ...atEntry, quote: bidQuote,
    daysToExpiry, valuationDate, spot: position.spot, spotBasis,
    outOfTheMoney: position.spot > 0 ? (position.spot - leg.strike) / position.spot : null,
    breakEven: leg.strike - leg.price,
    earnings: earningsBeforeExpiry(earningsDate, valuationDate, expiry),
  };
}

/**
 * The next report date, YYYY-MM-DD, as every earnings surface resolves it
 * (shared/earnings-calendar): the calendar's, or once that date has passed
 * the next one on record; null when there is none, and
 * EARNINGS_CALENDAR_UNAVAILABLE when the calendar cannot be read.
 */
export async function loadNextEarningsDate(provider: DataProvider | null | undefined, symbol: string, today = newYorkDay()): Promise<string | null> {
  const dates = await loadNextEarningsDates(provider, [symbol], today);
  return dates === EARNINGS_CALENDAR_UNAVAILABLE ? dates : dates.get(symbol.trim().toUpperCase()) ?? null;
}

/**
 * The next report date of each symbol, by its upper-case symbol, from one
 * calendar request; a symbol with none is left out. EARNINGS_CALENDAR_UNAVAILABLE
 * when the calendar cannot be read.
 */
export async function loadNextEarningsDates(
  provider: DataProvider | null | undefined, symbols: readonly string[], today = newYorkDay(),
): Promise<Map<string, string> | typeof EARNINGS_CALENDAR_UNAVAILABLE> {
  const keys = [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()))];
  const result = await loadEarningsCalendar(provider, keys).catch(logFailure("options-scenario.csp", "Load earnings calendar for cash-secured puts failed", null));
  if (provider && !result) return EARNINGS_CALENDAR_UNAVAILABLE;
  if (!provider || !result?.events.length) return new Map();
  const listings = keys.map((key) => {
    const listing = parsePublicTickerKey(key);
    return { key, symbol: listing.symbol, exchange: listing.exchange ?? "" };
  });
  const resolved = await resolveListingEvents(provider, listings, result.events, today);
  return new Map(keys.flatMap((key) => {
    const date = upcomingReportDate(resolved.get(key));
    return date ? [[key, date] as const] : [];
  }));
}

const money = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const percent = (fraction: number, digits = 2) => `${(fraction * 100).toFixed(digits)}%`;
const unitOf = (csp: CashSecuredPut) => csp.currency && csp.currency !== UNKNOWN_CURRENCY ? ` ${csp.currency}` : "";
const strikeText = (value: number) => formatHedgePrice(value).replace(/\.00$/, "");

/** `5.5% below spot 89.98 (implied by option quotes)`, or above it for a put in the money. */
function otmText(csp: CashSecuredPut): string {
  if (csp.outOfTheMoney == null) return "--";
  const side = csp.outOfTheMoney >= 0 ? "below" : "above";
  return `${percent(Math.abs(csp.outOfTheMoney), 1)} ${side} spot ${money(csp.spot)} (${csp.spotBasis})`;
}

function earningsText(earnings: CspEarnings): string {
  if (earnings.unavailable) return "unknown (earnings calendar unavailable)";
  if (earnings.beforeExpiry == null) return "unknown (no upcoming date published)";
  return `${earnings.beforeExpiry ? "yes" : "no"} (next report ${earnings.date})`;
}

const priceWord = (csp: CashSecuredPut) => csp.priceBasis === "mid" ? "quote mid" : "entry price";

/**
 * The report's Cash-secured put section. Each figure's `value` is in its
 * `unit`, every digit (a percent as a percent), so an export writes the number
 * and its unit; `formatted` is what text output prints.
 */
export function cspReportEntries(csp: CashSecuredPut): HeadlessPaneEntry[] {
  const unit = unitOf(csp);
  const amount = { unit: amountUnit(csp.currency) };
  const perShare = `${amount.unit} per share`;
  const quote = csp.quote;
  return [
    { key: "cashSecured", label: "Cash secured", value: csp.cashSecured, ...amount,
      formatted: `${money(csp.cashSecured)}${unit} (${strikeText(csp.strike)} x ${csp.multiplier} x ${csp.contracts})` },
    { key: "premium", label: "Premium received", value: csp.premium, ...amount,
      formatted: `${money(csp.premium)}${unit} (${formatHedgePrice(csp.price)} per share, ${priceWord(csp)})` },
    { key: "yieldOnCash", label: "Yield on cash", value: exportPercent(csp.yieldOnCash), unit: "%",
      formatted: `${percent(csp.yieldOnCash)} (${money(csp.premium)} / ${money(csp.cashSecured)})` },
    { key: "annualizedYield", label: "Annualised yield", value: exportPercent(csp.annualizedYield), unit: "%",
      formatted: csp.annualizedYield == null ? "-- (expires today)" : `${percent(csp.annualizedYield)} (yield on cash x 365 / ${csp.daysToExpiry})` },
    ...(quote ? [
      { key: "bid", label: "Bid", value: quote.bid, unit: perShare, formatted: `${formatHedgePrice(quote.bid)} per share` },
      { key: "ask", label: "Ask", value: quote.ask, unit: perShare, formatted: `${formatHedgePrice(quote.ask)} per share` },
      { key: "spread", label: "Spread", value: exportPercent(quote.spreadOfMid), unit: "% of mid",
        formatted: `${formatHedgePrice(quote.spread)} per share (${percent(quote.spreadOfMid, 1)} of the mid)` },
      { key: "bidPremium", label: "Premium at the bid", value: quote.bidPremium, ...amount,
        formatted: `${money(quote.bidPremium)}${unit} (${formatHedgePrice(quote.bid)} x ${csp.multiplier} x ${csp.contracts})` },
      { key: "bidAnnualizedYield", label: "Annualised yield at the bid", value: exportPercent(quote.bidAnnualizedYield), unit: "%",
        formatted: quote.bidAnnualizedYield == null ? "-- (expires today)"
          : `${percent(quote.bidAnnualizedYield)} (${percent(quote.bidYieldOnCash)} on cash x 365 / ${csp.daysToExpiry})` },
    ] : []),
    { key: "outOfTheMoney", label: "Out of the money", value: exportPercent(csp.outOfTheMoney), unit: "%", formatted: otmText(csp) },
    { key: "breakEven", label: "Break-even", value: csp.breakEven, unit: perShare,
      formatted: `${formatHedgePrice(csp.breakEven)} per share (${strikeText(csp.strike)} - ${formatHedgePrice(csp.price)})` },
    { key: "daysToExpiry", label: "Days to expiry", value: csp.daysToExpiry, unit: "days",
      formatted: `${csp.daysToExpiry} (${csp.valuationDate} to ${csp.expiry})` },
    { key: "earningsBeforeExpiry", label: "Earnings before expiry", value: csp.earnings.beforeExpiry, formatted: earningsText(csp.earnings) },
  ];
}

/** The pane's figures: the same numbers as the report, sized for a StatGrid. */
export function cspStatItems(csp: CashSecuredPut): StatItem[] {
  const earnings = csp.earnings;
  const quote = csp.quote;
  return [
    { id: "csp-cash", label: "Cash secured", value: money(csp.cashSecured), detail: `${strikeText(csp.strike)} x ${csp.multiplier * csp.contracts}` },
    { id: "csp-premium", label: "Premium", value: money(csp.premium), detail: `${priceWord(csp)} ${formatHedgePrice(csp.price)}` },
    { id: "csp-yield", label: "Yield", value: percent(csp.yieldOnCash),
      detail: csp.annualizedYield == null ? "expires today" : `${percent(csp.annualizedYield)} a year` },
    ...(quote ? [
      { id: "csp-bid", label: "Bid / ask", value: `${formatHedgePrice(quote.bid)} / ${formatHedgePrice(quote.ask)}`,
        detail: `spread ${percent(quote.spreadOfMid, 1)} of mid` },
      { id: "csp-bid-yield", label: "At the bid", value: quote.bidAnnualizedYield == null ? "--" : percent(quote.bidAnnualizedYield),
        detail: quote.bidAnnualizedYield == null ? "expires today" : "a year" },
    ] : []),
    { id: "csp-otm", label: "OTM", value: csp.outOfTheMoney == null ? "--" : percent(csp.outOfTheMoney, 1),
      detail: `vs ${money(csp.spot)} ${csp.spotBasis === "implied by option quotes" ? "implied" : csp.spotBasis}` },
    { id: "csp-break-even", label: "Break-even", value: formatHedgePrice(csp.breakEven), detail: "per share" },
    { id: "csp-days", label: "DTE", value: String(csp.daysToExpiry), detail: csp.expiry },
    { id: "csp-earnings", label: "Earnings", value: earnings.beforeExpiry == null ? "unknown" : earnings.beforeExpiry ? "before expiry" : "after expiry",
      detail: earnings.unavailable ? "calendar unavailable" : earnings.date ?? "no date",
      tone: earnings.beforeExpiry || earnings.unavailable ? "warning" : undefined },
  ];
}
