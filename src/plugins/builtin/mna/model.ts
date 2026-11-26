import type { MnaDeal, MnaOutsideDate, MnaStatus, MnaTerms } from "../../../api-client/mna";
import type { Quote } from "../../../types/financials";
import { getListingSymbol } from "../../../sources/listing-symbols";
import { isRegularSessionTime, isVenueTradingDay, latestRegularSessionClose, regularSessionCloseOn } from "../../../market-data/market/freshness";
import { canonicalExchange, isUsListingExchange, parsePublicTickerKey } from "../../../utils/exchanges";
import { zonedDateTimeParts } from "../../../utils/zoned-date-time";
import { MISSING_VALUE, formatCompact } from "../../../utils/format";
import { nonUsSecListingVenue } from "../../../utils/sec";

export const MNA_PANE_ID = "mna";
export const MISSING = MISSING_VALUE;

const MS_PER_DAY = 86_400_000;

/** What the deal table says with no rows: the search that matched none, or the company with no deal; on a split pending list, which half. */
export function emptyDealsTitle(symbol: string | null, query: string, terms: "priced" | "unpriced" | null = null): string {
  const kind = terms === "priced" ? "priced deals" : terms === "unpriced" ? "deals without terms" : "deals";
  return query ? `No matching ${kind}.` : symbol ? `No ${kind} involving ${symbol}.` : `No ${kind}.`;
}

const CURRENCY_SIGNS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£", JPY: "¥", CNY: "¥", INR: "₹", KRW: "₩" };

/** "$10.50", "€4.20", "1,250p", "CHF 88.00". */
export function formatPerShare(amount: number, currency: string | null, maxDigits = 4): string {
  const code = (currency ?? "USD").trim();
  if (code === "GBp" || code === "GBX") return `${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}p`;
  const fixed = amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: maxDigits });
  const sign = CURRENCY_SIGNS[code.toUpperCase()];
  return sign ? `${sign}${fixed}` : `${code} ${fixed}`;
}

/** A headline amount: "$1.8B", "€420M", "GBP 1.2B"; "$1.80B" in a table column. */
export function formatDealValue(value: number | null, currency: string | null): string {
  if (value == null || !Number.isFinite(value) || value <= 0) return MISSING;
  const compact = formatCompact(value);
  const code = currency?.trim().toUpperCase() ?? "";
  if (!code) return compact;
  const sign = CURRENCY_SIGNS[code];
  return sign ? `${sign}${compact}` : `${code} ${compact}`;
}

function ratioLabel(ratio: number, symbol: string | null): string {
  const shares = ratio.toLocaleString("en-US", { maximumFractionDigits: 4 });
  return symbol ? `${shares} ${symbol}` : `${shares} sh`;
}

/**
 * The symbol a company's deals are filed under, from the ticker a pane is
 * linked to. A deal carries its companies' quote symbols: plain for a US
 * listing, suffixed by the venue elsewhere (ATH.TO, SHEL.L, 9984.T). A
 * listing abroad therefore asks by that quote symbol: its bare symbol is
 * another company's US ticker (ATH is Athene in New York, Athabasca in
 * Toronto). A US listing, a symbol with no venue and a symbol already
 * suffixed go as they are, so a US ticker is asked for exactly as before.
 * `savedExchange` is the venue the saved ticker names, for a key with none.
 */
export function dealsSymbol(key: string | null | undefined, savedExchange = ""): string {
  const value = key?.trim();
  if (!value) return "";
  if (nonUsSecListingVenue(value, savedExchange)) return getListingSymbol(value, savedExchange).toUpperCase();
  return parsePublicTickerKey(value).symbol;
}

/** Each holder gets the cash or the shares, not both. Older servers never say so. */
export function isElection(terms: MnaTerms): boolean {
  return terms.election === true && terms.cashPerShare != null && terms.exchangeRatio != null;
}

/** What one target share gets, in as few characters as the terms allow. */
export function termsLabel(terms: MnaTerms): string {
  const parts: string[] = [];
  if (terms.cashPerShare != null) {
    parts.push(terms.exchangeRatio == null
      ? `${formatPerShare(terms.cashPerShare, terms.currency)} cash`
      : formatPerShare(terms.cashPerShare, terms.currency));
  }
  if (terms.exchangeRatio != null) parts.push(ratioLabel(terms.exchangeRatio, terms.ratioSymbol));
  if (parts.length === 0) {
    parts.push(terms.consideration === "cash" ? "Cash"
      : terms.consideration === "stock" ? "Stock"
        : terms.consideration === "mixed" ? "Cash and stock"
          : MISSING);
  }
  let label = parts.join(isElection(terms) ? " or " : " + ");
  if (terms.cvr) label += " + CVR";
  if (terms.partial) label += ", partial";
  return label;
}

/**
 * Pending deals split by whether they say what one target share gets: a deal
 * with cash or an exchange ratio per share has a spread to read (merger
 * arbitrage), one announced as "cash" or with no terms yet has none, and
 * its own shorter row.
 */
export type MnaTermsView = "priced" | "unpriced";

export const MNA_TERMS_VIEWS: readonly { value: MnaTermsView; label: string }[] = [
  { value: "priced", label: "Priced" },
  { value: "unpriced", label: "No terms" },
];

export function isMnaTermsView(value: unknown): value is MnaTermsView {
  return value === "priced" || value === "unpriced";
}

/** Cash or shares per target share: what a spread prices. */
function hasPerShareTerms(terms: MnaTerms): boolean {
  return terms.cashPerShare != null || terms.exchangeRatio != null;
}

export function mnaTermsView(deal: Pick<MnaDeal, "terms">): MnaTermsView {
  return hasPerShareTerms(deal.terms) ? "priced" : "unpriced";
}

const STATUS_LABELS: Record<MnaStatus, string> = {
  talks: "Talks",
  pending: "Pending",
  completed: "Completed",
  terminated: "Terminated",
};

/** The stage says more than "Pending" once a deal has one. */
export function stageLabel(deal: MnaDeal): string {
  if (deal.stale) return `No news since ${formatListDate(deal.lastReported)}`;
  if (deal.status === "pending") return deal.hostile ? `Hostile${deal.stage ? `, ${deal.stage.toLowerCase()}` : ""}` : deal.stage ?? "Pending";
  if (deal.status === "talks") return deal.acquirer ? "Talks" : "Exploring sale";
  return STATUS_LABELS[deal.status];
}

const PENCE = new Set(["GBp", "GBX"]);

/**
 * London quotes arrive in pounds while UK offers are often in pence, so the
 * two compare after scaling; any other currency mismatch has no price.
 */
export function inQuoteCurrency(amount: number, from: string | null, quoteCurrency: string | undefined): number | null {
  const offer = from ?? "USD";
  const quote = quoteCurrency ?? "USD";
  if (offer === quote) return amount;
  if (offer === "GBP" && PENCE.has(quote)) return amount * 100;
  if (PENCE.has(offer) && quote === "GBP") return amount / 100;
  if (PENCE.has(offer) || PENCE.has(quote)) return null;
  return offer.toUpperCase() === quote.toUpperCase() ? amount : null;
}

function cashLeg(terms: MnaTerms, targetQuote: Quote | null): number | null {
  return terms.cashPerShare == null ? null : inQuoteCurrency(terms.cashPerShare, terms.currency, targetQuote?.currency);
}

function stockLeg(terms: MnaTerms, targetQuote: Quote | null, ratioQuote: Quote | null, price = ratioQuote?.price): number | null {
  if (terms.exchangeRatio == null || !terms.ratioSymbol || price == null || !Number.isFinite(price) || price <= 0) return null;
  const leg = inQuoteCurrency(price, ratioQuote?.currency ?? null, targetQuote?.currency);
  return leg == null ? null : terms.exchangeRatio * leg;
}

/**
 * The leg an election is priced at. It pays each holder the cash or the
 * shares, never both, so it is priced at its cash leg: the legs are set about
 * equal at signing, proration means a holder cannot count on getting the
 * stock, and the cash does not move. The stock leg stands in only when the
 * cash cannot be compared with the target's quote. Without a quote, the cash.
 */
export function electionLeg(terms: MnaTerms, targetQuote: Quote | null): "cash" | "stock" {
  return !targetQuote || cashLeg(terms, targetQuote) != null ? "cash" : "stock";
}

/**
 * What the terms pay per target share at the latest prices, in the target
 * quote's currency. Null when a leg cannot be priced: no terms, a ratio
 * without its listing, or cash in another currency. An election is one leg,
 * the one {@link electionLeg} picks.
 */
function offerValue(deal: MnaDeal, targetQuote: Quote | null, ratioQuote: Quote | null, ratioPrice = ratioQuote?.price): number | null {
  const { terms } = deal;
  if (terms.cashPerShare == null && terms.exchangeRatio == null) return null;
  let total: number | null;
  if (isElection(terms)) {
    total = electionLeg(terms, targetQuote) === "cash"
      ? cashLeg(terms, targetQuote)
      : stockLeg(terms, targetQuote, ratioQuote, ratioPrice);
  } else {
    const cash = terms.cashPerShare == null ? 0 : cashLeg(terms, targetQuote);
    const stock = terms.exchangeRatio == null ? 0 : stockLeg(terms, targetQuote, ratioQuote, ratioPrice);
    total = cash == null || stock == null ? null : cash + stock;
  }
  return total != null && total > 0 ? total : null;
}

/** Whether the offer moves with the paying listing's price: a share leg it is priced at. */
function pricedByRatio(deal: MnaDeal, targetQuote: Quote | null): boolean {
  const { terms } = deal;
  if (terms.exchangeRatio == null || !terms.ratioSymbol) return false;
  return !isElection(terms) || electionLeg(terms, targetQuote) === "stock";
}

/**
 * What the terms were worth each day since the announcement: flat for cash,
 * the ratio times the paying listing's close for stock. An election draws
 * the one leg its Offer is priced at (`leg`, from {@link electionLeg}), its
 * stock leg in the target quote's currency as the Offer converts it.
 */
export function offerSeries(
  deal: MnaDeal,
  ratioCloses: readonly { date: Date; close: number }[],
  days: readonly string[],
  leg: "cash" | "stock" | null,
  toQuote: (close: number) => number | null = (close) => close,
): Array<{ day: string; value: number }> {
  const { cashPerShare, exchangeRatio, currency } = deal.terms;
  if (cashPerShare == null && exchangeRatio == null) return [];
  const pence = currency === "GBp" || currency === "GBX";
  const cash = cashPerShare == null || leg === "stock" ? 0 : pence ? cashPerShare / 100 : cashPerShare;
  const ratioByDay = new Map(ratioCloses.map((point) => [point.date.toISOString().slice(0, 10), point.close]));
  const out: Array<{ day: string; value: number }> = [];
  let lastRatio: number | null = null;
  for (const day of days) {
    if (day < deal.announced) continue;
    if (exchangeRatio == null || leg === "cash") {
      out.push({ day, value: cash });
      continue;
    }
    const close = ratioByDay.get(day);
    lastRatio = close == null ? lastRatio : toQuote(close) ?? lastRatio;
    if (lastRatio != null) out.push({ day, value: cash + exchangeRatio * lastRatio });
  }
  return out;
}

/** Legs whose prints are further apart than this are not one moment's prices: the row flags them. */
const LEGS_APART_MS = 30 * 60_000;

/**
 * The session a print was made in, as its venue's hours place it: `closed`
 * for one made when no session was open, on a weekend or a holiday, or on a
 * night no overnight session follows.
 */
export type PrintSession = "regular" | "pre-market" | "after-hours" | "overnight" | "closed";

/** One leg's latest print: the target's, or the listing a ratio pays in. */
export interface SpreadLeg {
  symbol: string;
  /** In the leg's own quote currency. */
  price: number;
  /** When it traded (epoch ms); null when the quote does not say. */
  at: number | null;
  session: PrintSession | null;
}

/**
 * What a spread's two prices are. `close`: each leg's official close of one
 * regular session (`session`, the venues' local date), which is how it is
 * priced whenever a leg's venue is out of its regular session. `last`: the
 * legs' last trades, in the regular session or when no matching closes are
 * known; `at` is the older trade's time, `apartMs` how far apart the two
 * trades are (null without both times; 0 for one leg).
 */
export type SpreadBasis =
  | { kind: "close"; session: string }
  | { kind: "last"; at: number | null; apartMs: number | null; session: PrintSession | null };

export interface DealSpread {
  offer: number;
  price: number;
  /** Fraction of the target price, e.g. 0.004 for 0.4%. */
  spread: number;
  /** Simple annualized spread to the expected close; null past it or without a date. */
  annualized: number | null;
  /** Which prices the offer and the spread are at. */
  basis: SpreadBasis;
  /**
   * The spread at the legs' latest prints, beside a close basis whose legs
   * have traded since that close (pre-market, after hours): its own basis
   * says when they traded and how far apart. Null otherwise.
   */
  latest: { offer: number; price: number; spread: number; basis: Extract<SpreadBasis, { kind: "last" }> } | null;
  /** Each leg's latest print, the target first. */
  legs: SpreadLeg[];
}

/** When a quote's price traded: its last trade, else its last update. */
function printTime(quote: Quote): number | null {
  const at = quote.lastTradeTime ?? quote.lastUpdated;
  return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
}

/** The calendar day after a `YYYY-MM-DD`. */
function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

/**
 * The session `at` falls in on the quote's venue, read from its calendar:
 * its regular hours; on a trading day, before the open (pre-market; for a
 * US listing overnight before 04:00 New York) or after the close (after
 * hours; for a US listing overnight from 20:00 when the next day trades).
 * A day the venue does not trade (a weekend, a holiday) has no session of
 * its own: `closed`, but for a US listing's overnight session from 20:00 on
 * the eve of a trading day (Sunday night). Null for a venue with unknown hours.
 */
function printSession(quote: Pick<Quote, "listingExchangeName" | "exchangeName">, at: number): PrintSession | null {
  const exchange = quote.listingExchangeName || quote.exchangeName;
  const regular = isRegularSessionTime(exchange, at);
  if (regular === null) return null;
  if (regular) return "regular";
  const latest = latestRegularSessionClose(exchange, at);
  if (!latest) return null;
  const local = zonedDateTimeParts(at, latest.timeZone);
  const date = `${local.year}-${String(local.month).padStart(2, "0")}-${String(local.day).padStart(2, "0")}`;
  const minutes = local.hour * 60 + local.minute;
  const us = isUsListingExchange(canonicalExchange(exchange));
  const eveOfSession = us && minutes >= 20 * 60 && isVenueTradingDay(exchange, nextDay(date));
  if (!isVenueTradingDay(exchange, date)) return eveOfSession ? "overnight" : "closed";
  const close = regularSessionCloseOn(exchange, date);
  if (close != null && at >= close) return eveOfSession ? "overnight" : us && minutes >= 20 * 60 ? "closed" : "after-hours";
  return us && minutes < 4 * 60 ? "overnight" : "pre-market";
}

function leg(quote: Quote): SpreadLeg | null {
  const price = quote.price;
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const at = printTime(quote);
  return { symbol: quote.symbol, price, at, session: at == null ? null : printSession(quote, at) };
}

/** The last-trade basis of these legs: the older trade, and how far apart the two are. */
function lastBasis(legs: readonly SpreadLeg[]): Extract<SpreadBasis, { kind: "last" }> {
  const times = legs.map((entry) => entry.at);
  if (times.some((at) => at == null)) return { kind: "last", at: null, apartMs: null, session: null };
  const known = times as number[];
  const at = Math.min(...known);
  return { kind: "last", at, apartMs: Math.max(...known) - at, session: legs[known.indexOf(at)]!.session };
}

/** The close a quote reports of a completed regular session, with that session's date. */
function sessionClose(quote: Quote): { price: number; session: string } | null {
  const price = quote.regularClose;
  const session = quote.regularCloseSessionDate;
  return price != null && Number.isFinite(price) && price > 0 && session ? { price, session } : null;
}

/** Last day of a "Q1 2027", "H2 2026" or "2026" close; a full date passes through. */
export function expectedCloseDate(value: string | null): Date | null {
  if (!value) return null;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const date = new Date(Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3])));
    return date.toISOString().slice(0, 10) === text ? date : null;
  }
  const quarter = /^Q([1-4])\s+(\d{4})$/i.exec(text);
  if (quarter) return new Date(Date.UTC(Number(quarter[2]), Number(quarter[1]) * 3, 0));
  const half = /^H([12])\s+(\d{4})$/i.exec(text);
  if (half) return new Date(Date.UTC(Number(half[2]), Number(half[1]) * 6, 0));
  const year = /^(\d{4})$/.exec(text);
  if (year) return new Date(Date.UTC(Number(year[1]), 12, 0));
  return null;
}

/** "15 Oct", "Oct '27" (a month in another year), "Q1 27", "2027". */
export function formatExpectedClose(value: string | null, now = new Date()): string {
  if (!value) return MISSING;
  const text = value.trim();
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const date = new Date(`${text}T00:00:00Z`);
    const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
    return date.getUTCFullYear() === now.getUTCFullYear() ? `${Number(day[3])} ${month}` : `${month} '${day[1]!.slice(2)}`;
  }
  const period = /^([QH][1-4])\s+(\d{4})$/i.exec(text);
  if (period) return `${period[1]!.toUpperCase()} ${period[2]!.slice(2)}`;
  return text;
}

/**
 * The arbitrage spread of a pending deal at the latest prices. A partial
 * offer's spread applies only to the prorated slice, so it has no
 * annualized figure; neither has a negative spread, which says the market
 * expects better terms rather than a return.
 */
export function dealSpread(
  deal: MnaDeal,
  targetQuote: Quote | null,
  ratioQuote: Quote | null,
  now = Date.now(),
): DealSpread | null {
  if (deal.status !== "pending" || !deal.target.symbol || !targetQuote) return null;
  const target = leg(targetQuote);
  if (!target) return null;
  const ratio = pricedByRatio(deal, targetQuote) ? (ratioQuote ? leg(ratioQuote) : null) : null;
  const latestOffer = offerValue(deal, targetQuote, ratioQuote);
  if (latestOffer == null) return null;
  const legs = ratio ? [target, ratio] : [target];
  const quotes = ratio ? [targetQuote, ratioQuote!] : [targetQuote];
  const latest = { offer: latestOffer, price: target.price, spread: latestOffer / target.price - 1, basis: lastBasis(legs) };

  // Out of the regular session, the legs' closes of one session: the latest
  // prints of a pre-market or an evening are hours apart and thinly traded.
  const outOfSession = quotes.some((quote) => quote.marketState != null && quote.marketState !== "REGULAR");
  const closes = quotes.map(sessionClose);
  const matched = outOfSession && closes.every((close) => close && close.session === closes[0]!.session);
  let priced: Pick<DealSpread, "offer" | "price" | "spread" | "basis" | "latest">;
  if (matched) {
    const offer = offerValue(deal, targetQuote, ratioQuote, ratio ? closes[1]!.price : undefined);
    if (offer == null) return null;
    const price = closes[0]!.price;
    // The latest prints are worth showing beside the close once a leg has traded since it.
    const traded = legs.some((entry, index) => entry.price !== closes[index]!.price);
    priced = { offer, price, spread: offer / price - 1, basis: { kind: "close", session: closes[0]!.session }, latest: traded ? latest : null };
  } else {
    priced = { ...latest, latest: null };
  }
  const days = daysToExpectedClose(deal, now);
  const annualized = !deal.terms.partial && priced.spread > 0 && days != null && days >= MIN_ANNUALIZED_DAYS
    ? priced.spread * 365 / days
    : null;
  return { ...priced, annualized, legs };
}

/** A close nearer than this, or past, has no annual rate to state: the spread is all that is left of the return. */
const MIN_ANNUALIZED_DAYS = 1;

/** Days from `now` to the expected close, negative once it has come; null with no date to read. */
function daysToExpectedClose(deal: Pick<MnaDeal, "expectedClose">, now: number): number | null {
  const close = expectedCloseDate(deal.expectedClose);
  return close ? (close.getTime() - now) / MS_PER_DAY : null;
}

/**
 * Whether the ANN. of a deal that has a spread to read is blank with no
 * figure missing, by the terms dealSpread states no annual return on: the
 * offer is for part of the shares, the expected close is less than a day off
 * (MIN_ANNUALIZED_DAYS, the one boundary both read), or the spread is not
 * positive.
 *
 * The first two are the deal's own, so they hold with no quote too (`spread`
 * null): such a deal never has the figure, whatever its price turns out to
 * be. The third takes a quote to know.
 *
 * Every other deal owes the figure. A full offer a day or more from its close
 * has an annual return wherever its spread is positive, so its blank is a
 * figure the list lost, or a quote it lost, however well the date reads. One
 * with no close date to annualize to follows the CLOSE the deal owes: the
 * list cannot tell a deal that gives no date from one whose date was lost.
 */
export function annualizedMayBeBlank(deal: Pick<MnaDeal, "terms" | "expectedClose">, spread: DealSpread | null, now: number): boolean {
  if (spread?.annualized != null) return false;
  if (deal.terms.partial) return true;
  const days = daysToExpectedClose(deal, now);
  if (days != null && days < MIN_ANNUALIZED_DAYS) return true;
  return spread != null && spread.spread <= 0;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `Mon close` within the week, `6 Nov close` before it; `Mon 16 Nov close` dated in full. */
export function closeBasisLabel(session: string, now = Date.now(), { dated = false }: { dated?: boolean } = {}): string {
  const day = new Date(`${session}T00:00:00Z`);
  if (!Number.isFinite(day.getTime())) return "close";
  const weekday = WEEKDAYS[day.getUTCDay()]!;
  const date = `${day.getUTCDate()} ${MONTHS[day.getUTCMonth()]}`;
  if (dated) return `${weekday} ${date} close`;
  return (now - day.getTime()) / MS_PER_DAY < 6 ? `${weekday} close` : `${date} close`;
}

/** How far apart two prints are, in the larger unit that says it: `45m`, `8h`, `3d`. */
export function apartText(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Whether a basis is two trades far enough apart that the spread is no one moment's. */
export function legsApart(basis: SpreadBasis): boolean {
  return basis.kind === "last" && basis.apartMs != null && basis.apartMs > LEGS_APART_MS;
}

/** A print's session when it is not the regular one (`pre-market`, `after-hours`, `overnight`, `closed`); empty for the regular session. */
function extendedSessionWord(session: PrintSession | null): string {
  return session && session !== "regular" ? session : "";
}

/** A print's time, after its session when that is not the regular one: `pre-market 04:24`, `15:42`. */
export function printWhen(at: number, session: PrintSession | null, clock: (at: number) => string): string {
  const word = extendedSessionWord(session);
  return word ? `${word} ${clock(at)}` : clock(at);
}

/**
 * The basis as the detail's figures say it: `Mon close`; the older trade's
 * time (`clock`), after its session when that is not the regular one
 * (`pre-market 04:24`); `8h apart` for trades too far apart to be one
 * moment's. With `timed: false`, as the narrow AS OF cell says it, a trade
 * outside the regular session is its session alone (`pre-market`): the
 * detail times it. MISSING when the trades are not timed.
 */
export function spreadBasisLabel(basis: SpreadBasis, clock: (at: number) => string, now = Date.now(), { timed = true }: { timed?: boolean } = {}): string {
  if (basis.kind === "close") return closeBasisLabel(basis.session, now);
  if (legsApart(basis)) return `${apartText(basis.apartMs!)} apart`;
  if (basis.at == null) return MISSING;
  const word = extendedSessionWord(basis.session);
  return word && !timed ? word : printWhen(basis.at, basis.session, clock);
}

/** Target name for a table cell: the symbol when listed, else the name. */
export function partyCell(party: { name: string; symbol: string | null } | null, preferSymbol: boolean): string {
  if (!party) return MISSING;
  return preferSymbol && party.symbol ? party.symbol : party.name;
}

/** "Sep 10" this year, "Dec 2025" before it. */
export function formatListDate(value: string, now = new Date()): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return MISSING;
  const month = date.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return date.getUTCFullYear() === now.getUTCFullYear() ? `${date.getUTCDate()} ${month}` : `${month} ${date.getUTCFullYear()}`;
}

/** `4 May 2027`: a deadline's whole day, its year always, since it is usually next year's. */
function formatDeadline(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return value;
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/**
 * An outside date in its parts: the date (`4 May 2027`), the later one it
 * moves to and on what (`to 4 Nov 2027 if only antitrust approvals remain`),
 * and the filing it is read from (`8-K 4 Nov 2026`).
 */
export function outsideDateParts(outside: MnaOutsideDate): { date: string; extension: string | null; source: string } {
  const extension = outside.extendedTo
    ? `to ${formatDeadline(outside.extendedTo)}${outside.extension ? ` ${outside.extension}` : ""}`
    : null;
  return { date: formatDeadline(outside.date), extension, source: `${outside.source.form} ${formatDeadline(outside.source.filed)}` };
}

/** 0.0038 is "0.38%", -0.049 is "-4.9%": tight arb spreads keep two decimals. */
export function formatPercentShort(value: number): string {
  const percent = value * 100;
  const digits = Math.abs(percent) < 1 ? 2 : 1;
  const fixed = percent.toFixed(digits);
  return `${/[1-9]/.test(fixed) ? fixed : fixed.replace("-", "")}%`;
}

export function formatPrice(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 4 : 2 });
}
