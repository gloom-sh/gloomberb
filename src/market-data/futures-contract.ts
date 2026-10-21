import { apiClient } from "../api-client";
import type { FuturesContractSpec, FuturesContractTermsPayload } from "../api-client/futures-curve";
import { classifyInstrumentType } from "../tickers/instrument-kind";
import type { Quote } from "../types/financials";
import { parsePublicTickerKey } from "../utils/exchanges";
import { logFailure } from "../utils/log-failure";
import { futuresBoardContract, type FuturesContract } from "./futures-board";
import { formatMarketPrice, formatMarketPriceWithCurrency, quoteFormatOptions, withCurrencyMinorDigits } from "./market/format";
import { previousPublishedSession } from "./market/freshness";
import { minorUnitSign } from "../utils/currency-units";
import { contractPriceUnit } from "../time-series/price-units";

/**
 * What a futures symbol trades, as `ticker`, `quote` and the Overview tab read
 * it: one Settle value dated by its session and one list of contract lines, so
 * the three cannot word the same contract differently. Margins are not part of
 * the terms: nothing here shows or estimates one.
 */

/** A settlement the exchange has not confirmed reads as CTM writes a missing price. */
const FUTURES_MISSING = "--";

type FuturesContractLineKey = "contract" | "unit" | "size" | "tick" | "pointValue" | "settlement" | "firstNotice" | "lastTrade"
  | "roll" | "front" | "nearest" | "mostActive";

export interface FuturesContractLine {
  key: FuturesContractLineKey;
  label: string;
  value: string;
  /** Past first notice: a long can be assigned delivery. */
  warning?: true;
}

/**
 * Which lines a short or narrow block keeps, best first: the month the symbol
 * prices, what one contract and one tick are worth, and when delivery starts.
 * The unit, last trade, settlement type and point value follow from those.
 */
const LINE_RANK: Readonly<Record<FuturesContractLineKey, number>> = {
  contract: 0, size: 1, tick: 2, firstNotice: 3, unit: 4, lastTrade: 5, settlement: 6, pointValue: 7,
  front: 8, roll: 9, nearest: 10, mostActive: 11,
};

const SETTLEMENT_TYPE: Readonly<Record<FuturesContractSpec["settlement"], string>> = {
  physical: "Physical delivery",
  cash: "Cash settled",
};

/** Whether a symbol is a futures contract, an alias (GC=F) or a generic (CL1), whose contract terms are worth asking for. */
export function isFuturesInstrument(symbol: string, instrumentType: string | null | undefined): boolean {
  return classifyInstrumentType(instrumentType) === "future" || /=F$/i.test(symbol.trim());
}

function decimals(value: number): number {
  return value.toFixed(10).replace(/0+$/, "").split(".")[1]?.length ?? 0;
}

/** A tick at its own precision and what it makes on one contract: "0.10 = $10.00", "0.015625 = $15.625". */
export function futuresTickText(spec: Pick<FuturesContractSpec, "tick" | "tickValue">): string {
  const value = spec.tickValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: Math.max(2, decimals(spec.tickValue)) });
  return `${spec.tick.toFixed(Math.max(2, decimals(spec.tick)))} = $${value}`;
}

/** One contract of a root, from the exchange's rulebook: the terms a hedge is sized on. */
export function futuresSpecLines(spec: FuturesContractSpec): FuturesContractLine[] {
  return [
    { key: "unit", label: "Unit", value: spec.unit },
    { key: "size", label: "Size", value: spec.size },
    { key: "tick", label: "Tick", value: futuresTickText(spec) },
    { key: "pointValue", label: "Point Value", value: `$${spec.pointValue.toLocaleString("en-US")}` },
    { key: "settlement", label: "Settlement", value: SETTLEMENT_TYPE[spec.settlement] },
  ];
}

/** A contract as traders write it: GCZ26.CMX is GCZ26. */
function contractCode(symbol: string): string {
  return parsePublicTickerKey(symbol).symbol.replace(/\.[A-Z]+$/, "");
}

/**
 * The Contract block: the contract an alias or a generic prices, its terms and
 * the dates a long faces delivery. A line with nothing to say is left out, so
 * a cash-settled root has no first notice and a listed contract no Contract line.
 */
export function futuresContractLines(terms: FuturesContractTermsPayload, symbol: string): FuturesContractLine[] {
  const lines: FuturesContractLine[] = [];
  if (terms.contract && terms.contract !== contractCode(symbol)) lines.push({ key: "contract", label: "Contract", value: terms.contract });
  if (terms.spec) lines.push(...futuresSpecLines(terms.spec));
  if (terms.firstNotice) {
    lines.push(terms.inDelivery
      ? { key: "firstNotice", label: "First Notice", value: `${terms.firstNotice} (passed)`, warning: true }
      : { key: "firstNotice", label: "First Notice", value: terms.firstNotice });
  }
  if (terms.lastTrade) lines.push({ key: "lastTrade", label: "Last Trade", value: terms.lastTrade });
  return lines;
}

/** At most `max` lines, the least useful dropped first, in the block's own order. */
export function fitFuturesContractLines(lines: readonly FuturesContractLine[], max: number): FuturesContractLine[] {
  if (lines.length <= max) return [...lines];
  const kept = new Set([...lines].sort((a, b) => LINE_RANK[a.key] - LINE_RANK[b.key]).slice(0, Math.max(0, max)));
  return lines.filter((line) => kept.has(line));
}

/**
 * The exchange settlement dated by its session, `$4,216.30 (2026-10-09)`, as
 * `ticker` prints a futures price: in the quote's currency, padded to its minor
 * unit and at the contract's own precision, with or without a quote to hand.
 * Without a quote currency the price is a bare number, never a guessed `$`: a
 * grain settles in cents. A contract without a confirmed settlement reads
 * `--`: never an older settlement, and never the last trade.
 *
 * `movesFrom` is the session the Change line beside it is measured from
 * (futuresChangeBasis). The settlement is confirmed overnight, after the
 * quote has moved on to the next session, so for those hours the terms carry
 * the session before the one the move is from: that settlement would sit
 * beside a move from another session's close. It reads `--` and says which
 * session is not confirmed yet. A settlement of that session or a later one
 * is shown: the same session, or the one the move itself belongs to.
 */
export function futuresSettleText(
  terms: Pick<FuturesContractTermsPayload, "settlement">,
  quote: Pick<Quote, "currency" | "instrumentType" | "priceBasis" | "providerPriceDivisor"> | null | undefined,
  movesFrom?: string | null,
): string {
  if (!terms.settlement) return FUTURES_MISSING;
  if (movesFrom && terms.settlement.date < movesFrom) return `${FUTURES_MISSING} (${movesFrom} not confirmed yet)`;
  const currency = quote?.currency;
  const options = withCurrencyMinorDigits(quoteFormatOptions(quote, "FUTURE"), currency);
  const price = currency ? formatMarketPriceWithCurrency(terms.settlement.price, currency, options) : formatMarketPrice(terms.settlement.price, options);
  return `${price} (${terms.settlement.date})`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The quantities a cents price is per, as traders abbreviate them: 467.25¢/bu for corn. */
const PER_ABBREVIATIONS: Readonly<Record<string, string>> = { bushel: "bu", bushels: "bu", pound: "lb", pounds: "lb" };

/**
 * What a price in a minor unit is per, to follow its sign: "/lb" for coffee at
 * 314.95¢/lb, "/bu" for corn, from the contract's unit ("US cents / lb").
 * Empty for a price in a major currency, which reads as it always has, and
 * when the terms name no unit in the quote's own currency.
 */
export function minorUnitPricePer(
  terms: Pick<FuturesContractTermsPayload, "spec"> | null | undefined,
  currency: string | null | undefined,
): string {
  if (!minorUnitSign(currency)) return "";
  const per = contractPriceUnit(terms?.spec?.unit, currency)?.split("/")[1]?.trim();
  return per ? `/${PER_ABBREVIATIONS[per.toLowerCase()] ?? per}` : "";
}

const DAY_MS = 86_400_000;
const isoDate = /^\d{4}-\d{2}-\d{2}$/;

/** The weekday on or before a date, Saturday and Sunday skipped. */
function weekdayOnOrBefore(date: string): string {
  let at = Date.parse(`${date}T00:00:00Z`);
  while (new Date(at).getUTCDay() % 6 === 0) at -= DAY_MS;
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * How far apart two prices can be and still be the same settlement: half the
 * contract's tick, so a move the source rounded still meets the settlement it
 * was measured from, and a price a tick away does not. Without a tick, half a
 * basis point of the price.
 */
function settlementTolerance(tick: number | null | undefined, price: number): number {
  const half = typeof tick === "number" && Number.isFinite(tick) && tick > 0 ? tick / 2 : Math.abs(price) * 5e-5;
  // Floating point never splits a price exactly half a tick away from the settlement.
  return half * (1 + 1e-9);
}

/**
 * What a futures move is measured from: a session's settlement, the last
 * trade of a session that settled elsewhere, or a session's close that the
 * settlement in the contract terms cannot confirm either way. `session` is
 * the date of that reference.
 */
export interface FuturesChangeBasis {
  kind: "settle" | "last trade" | "close";
  session: string;
}

/**
 * What the move a futures quote headlines is measured from, for the words
 * after it ("vs Fri 16 Oct settle", quoteChangeBasis). `sessionDate` is the
 * session the move belongs to (regularSessionDisplayDate); a Saturday or
 * Sunday is Friday's, as no session is dated on one, and a holiday CME Globex
 * traded is the next trade date's. The basis is only what the numbers show,
 * against the one settlement the contract terms carry: a reference (the price
 * less the move) within half a tick of it is that settlement, of whichever
 * session it is. A reference that is not the settlement of the session just
 * before the move's is that session's last trade. Otherwise, when the terms
 * carry no settlement that old or one the reference can be checked against
 * (the move's own session has settled, and the one before is not in the
 * terms), it is the session before's close, left unnamed. The session before
 * is the trade date before the move's on the `exchange`'s published holiday
 * calendar (previousPublishedSession), so the Tuesday after Memorial Day
 * moves from Friday. On a venue without one, only a matching settlement is
 * named, by the date the terms give it. Null without a session date, a move
 * or terms, or when nothing but the calendar could date the reference and
 * there is none.
 */
export function futuresChangeBasis(
  terms: Pick<FuturesContractTermsPayload, "settlement"> & { spec?: Pick<FuturesContractSpec, "tick"> | null } | null | undefined,
  move: { price: number; change?: number | null; sessionDate?: string | null } | null | undefined,
  exchange: string | null | undefined,
): FuturesChangeBasis | null {
  const dated = move?.sessionDate;
  if (!terms || !move || !dated || !isoDate.test(dated) || move.change == null) return null;
  const reference = move.price - move.change;
  if (!Number.isFinite(reference)) return null;
  const session = weekdayOnOrBefore(dated);
  const previous = previousPublishedSession(exchange ?? undefined, dated, { closedDayRollsForward: true })?.date ?? null;
  const settled = terms.settlement;
  if (settled && settled.date <= session) {
    if (Math.abs(reference - settled.price) <= settlementTolerance(terms.spec?.tick, settled.price)) {
      return { kind: "settle", session: settled.date };
    }
    if (settled.date === previous) return { kind: "last trade", session: settled.date };
  }
  return previous ? { kind: "close", session: previous } : null;
}

/** A listed contract as code and month: "NGX26 (Nov 26)". */
function contractWithMonth(contract: { contract: string; deliveryMonth: string }): string {
  const [year, month] = contract.deliveryMonth.split("-");
  const name = MONTHS[Number(month) - 1];
  return name && year ? `${contract.contract} (${name} ${year.slice(2)})` : contract.contract;
}

/**
 * What `quote` adds to a futures row's Contract block: when a continuous
 * symbol or a generic leaves its contract, the root's front contract with its
 * own price when the symbol prices another one (NGF27, NG2), the nearer month
 * a rolled symbol has left, and the contract the day's volume made the most
 * active. A line with nothing to say is left out.
 */
export function futuresRollLines(
  terms: Pick<FuturesContractTermsPayload, "roll" | "front" | "nearest" | "mostActive">,
  frontQuote?: Pick<Quote, "price" | "lastUpdated" | "currency" | "instrumentType" | "priceBasis" | "providerPriceDivisor"> | null,
): FuturesContractLine[] {
  const lines: FuturesContractLine[] = [];
  if (terms.roll) lines.push({ key: "roll", label: "Rolls", value: terms.roll.date ? `${terms.roll.date}, ${terms.roll.label}` : terms.roll.label });
  if (terms.front) {
    const price = frontQuote && Number.isFinite(frontQuote.price) ? frontQuote.price : null;
    const options = withCurrencyMinorDigits(quoteFormatOptions(frontQuote, "FUTURE"), frontQuote?.currency);
    const priced = price == null ? null
      : frontQuote?.currency ? formatMarketPriceWithCurrency(price, frontQuote.currency, options) : formatMarketPrice(price, options);
    const at = frontQuote?.lastUpdated && Number.isFinite(frontQuote.lastUpdated)
      ? `${new Date(frontQuote.lastUpdated).toISOString().slice(0, 16).replace("T", " ")} UTC` : null;
    const value = priced ? `${contractWithMonth(terms.front)} ${priced}${at ? `, ${at}` : ""}`
      : `${contractWithMonth(terms.front)}${terms.front.lastTrade ? `, last trade ${terms.front.lastTrade}` : ""}`;
    lines.push({ key: "front", label: "Front", value });
  }
  if (terms.nearest) {
    lines.push({ key: "nearest", label: "Nearest", value: `${contractWithMonth(terms.nearest)}${terms.nearest.lastTrade
      ? `, last trade ${terms.nearest.lastTrade}` : ""}` });
  }
  if (terms.mostActive) {
    const { volume, date } = terms.mostActive;
    lines.push({ key: "mostActive", label: "Most Active",
      value: `${contractWithMonth(terms.mostActive)}, ${volume.toLocaleString("en-US")} contracts on ${date}` });
  }
  return lines;
}

const isDate = (value: unknown) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const optionalDate = (value: unknown) => value === null || isDate(value);
const positive = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value > 0;

/** Contract terms the text is computed from: a tick, its value and a point value, all positive. */
export function isFuturesContractSpec(spec: unknown): spec is FuturesContractSpec {
  if (!spec || typeof spec !== "object") return false;
  const row = spec as Record<string, unknown>;
  return typeof row.unit === "string" && typeof row.size === "string"
    && positive(row.tick) && positive(row.tickValue) && positive(row.pointValue)
    && (row.settlement === "physical" || row.settlement === "cash");
}

function isNearestContract(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.contract === "string" && typeof row.contractSymbol === "string"
    && typeof row.deliveryMonth === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.deliveryMonth) && optionalDate(row.lastTrade);
}

function isRoll(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.label === "string" && row.label.trim() !== "" && optionalDate(row.date);
}

function isMostActive(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return isNearestContract({ ...row, lastTrade: null }) && positive(row.volume) && Number.isInteger(row.volume) && isDate(row.date);
}

export function validateFuturesContractTerms(data: FuturesContractTermsPayload): FuturesContractTermsPayload {
  const settlement = data?.settlement as unknown;
  if (!data || typeof data !== "object" || typeof data.root !== "string"
    || !(data.contract === null || typeof data.contract === "string")
    || !(data.spec === null || isFuturesContractSpec(data.spec))
    || !optionalDate(data.lastTrade) || !optionalDate(data.firstNotice) || typeof data.inDelivery !== "boolean"
    || !(settlement === null || typeof settlement === "object" && Number.isFinite((settlement as { price?: unknown }).price)
      && isDate((settlement as { date?: unknown }).date))) {
    throw new Error("The server returned invalid futures contract terms");
  }
  // A nearest, front, roll or most active contract the server worded some other way is left out; the terms still stand.
  const checks = [["nearest", isNearestContract], ["front", isNearestContract], ["roll", isRoll], ["mostActive", isMostActive]] as const;
  const invalid = checks.filter(([key, valid]) => data[key] != null && !valid(data[key]));
  return invalid.length ? { ...data, ...Object.fromEntries(invalid.map(([key]) => [key, null])) } : data;
}

/** A futures symbol's contract, terms and latest confirmed settlement; throws when the server has none for it. */
export async function loadFuturesContractTerms(
  symbol: string,
  client: Pick<typeof apiClient, "getCloudFuturesContract"> = apiClient,
): Promise<FuturesContractTermsPayload> {
  // The terms are the contract's wherever it is listed: GC=F:CMX asks for GC=F.
  return validateFuturesContractTerms(await client.getCloudFuturesContract(parsePublicTickerKey(symbol).symbol));
}

/**
 * What a futures price counts: the exchange's unit from the contract terms
 * ("USD / gallon"), the catalog's where the server has none ("EUR / MWh"),
 * else null. FUT's Unit column and the chart composer read it the same way.
 */
export function futuresPriceUnit(
  contract: Pick<FuturesContract, "unit"> | null | undefined,
  terms?: Pick<FuturesContractTermsPayload, "spec"> | null,
): string | null {
  return terms?.spec?.unit ?? contract?.unit ?? null;
}

/** The terms change with a roll, and a roll is decided once a day. */
const PRICE_UNIT_TTL_MS = 30 * 60_000;
/** A failed request is asked again sooner than a settled answer. */
const PRICE_UNIT_RETRY_MS = 60_000;
const priceUnits = new Map<string, { at: number; ttl: number; unit: string | null }>();
const priceUnitsInFlight = new Map<string, Promise<string | null>>();

/**
 * A futures symbol's price unit (`futuresPriceUnit`), asked once per symbol
 * and kept for the rest of the session's roll window. A symbol whose terms
 * cannot be had falls back to the catalog's unit, or null.
 */
export function loadFuturesPriceUnit(
  symbol: string,
  load: (symbol: string) => Promise<FuturesContractTermsPayload> = loadFuturesContractTerms,
): Promise<string | null> {
  const key = parsePublicTickerKey(symbol).symbol.trim().toUpperCase();
  const cached = priceUnits.get(key);
  if (cached && Date.now() - cached.at < cached.ttl) return Promise.resolve(cached.unit);
  const pending = priceUnitsInFlight.get(key);
  if (pending) return pending;
  const contract = futuresBoardContract(key);
  const request = load(key)
    .then((terms) => ({ unit: futuresPriceUnit(contract, terms), ttl: PRICE_UNIT_TTL_MS }))
    .catch(() => ({ unit: futuresPriceUnit(contract, null), ttl: PRICE_UNIT_RETRY_MS }))
    .then(({ unit, ttl }) => {
      priceUnits.set(key, { at: Date.now(), ttl, unit });
      return unit;
    })
    .finally(() => { priceUnitsInFlight.delete(key); });
  priceUnitsInFlight.set(key, request);
  return request;
}

/** Forgets every remembered price unit (tests). */
export function resetFuturesPriceUnits(): void {
  priceUnits.clear();
  priceUnitsInFlight.clear();
}

/** A day's settlement lands the morning after its session; the terms change only with a roll. */
const TERMS_TTL_MS = 30 * 60_000;
const termsCache = new Map<string, { at: number; ttl: number; terms: FuturesContractTermsPayload | null }>();
const termsInFlight = new Map<string, Promise<FuturesContractTermsPayload | null>>();

function termsKey(symbol: string): string {
  return parsePublicTickerKey(symbol).symbol.trim().toUpperCase();
}

/**
 * A futures symbol's terms and settlement as portfolios read them: asked once
 * per symbol for the roll window, a failure again a minute later. Null when
 * the server has none for it or could not answer.
 */
export function loadFuturesContractTermsCached(
  symbol: string,
  load: (symbol: string) => Promise<FuturesContractTermsPayload> = loadFuturesContractTerms,
): Promise<FuturesContractTermsPayload | null> {
  const key = termsKey(symbol);
  const cached = termsCache.get(key);
  if (cached && Date.now() - cached.at < cached.ttl) return Promise.resolve(cached.terms);
  const pending = termsInFlight.get(key);
  if (pending) return pending;
  const request = load(key)
    .then((terms) => ({ terms, ttl: TERMS_TTL_MS }), (error: unknown) => {
      logFailure("futures-contract", "Read futures contract terms failed", null)(error);
      return { terms: null, ttl: PRICE_UNIT_RETRY_MS };
    })
    .then(({ terms, ttl }) => {
      termsCache.set(key, { at: Date.now(), ttl, terms });
      return terms;
    })
    .finally(() => { termsInFlight.delete(key); });
  termsInFlight.set(key, request);
  return request;
}
