import { apiClient } from "../api-client";
import type { FuturesContractSpec, FuturesContractTermsPayload } from "../api-client/futures-curve";
import { classifyInstrumentType } from "../tickers/instrument-kind";
import type { Quote } from "../types/financials";
import { parsePublicTickerKey } from "../utils/exchanges";
import { logFailure } from "../utils/log-failure";
import { futuresBoardContract, futuresContractByCode, type FuturesContract } from "./futures-board";
import { formatMarketPrice, formatMarketPriceWithCurrency, quoteFormatOptions, withCurrencyMinorDigits } from "./market/format";
import { previousPublishedSession } from "./market/freshness";
import { globexPrintSession } from "./market/globex-day";
import { minorUnitSign } from "../utils/currency-units";
import { contractPriceUnit } from "../time-series/price-units";
import { deliveryMonthLabel } from "../utils/contract-month";

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
    // A contract settled to another's says which: BZ is cash-settled to the ICE Brent futures settlement.
    { key: "settlement", label: "Settlement", value: spec.settlement === "cash" && spec.settlesTo?.trim()
      ? `${SETTLEMENT_TYPE.cash} to ${spec.settlesTo.trim()}` : SETTLEMENT_TYPE[spec.settlement] },
  ];
}

/** A contract as traders write it: GCZ26.CMX is GCZ26. */
function contractCode(symbol: string): string {
  return parsePublicTickerKey(symbol).symbol.replace(/\.[A-Z]+$/, "");
}

/**
 * A listed contract as `CTM` names it: its quote symbol without the venue,
 * GCZ26 for GCZ26.CMX and Cboe's VX/X6 for VIX November, so `quote` and the
 * curve write one contract alike. Its archive code where it has no symbol.
 */
export function futuresContractCode(contract: { contract: string | null; contractSymbol?: string | null }): string {
  return contract.contractSymbol ? contract.contractSymbol.replace(/\.[A-Z]+$/, "") : contract.contract ?? "";
}

/**
 * The Contract block: the contract an alias or a generic prices, its terms and
 * the dates a long faces delivery. A line with nothing to say is left out, so
 * a cash-settled root has no first notice and a listed contract no Contract line.
 */
export function futuresContractLines(terms: FuturesContractTermsPayload, symbol: string): FuturesContractLine[] {
  const lines: FuturesContractLine[] = [];
  const code = terms.contract ? futuresContractCode(terms) : null;
  if (code && code !== contractCode(symbol)) lines.push({ key: "contract", label: "Contract", value: code });
  if (terms.spec) lines.push(...futuresSpecLines(terms.spec));
  else {
    // A root the server sends no terms for still says what its price counts: Dutch TTF gas is EUR / MWh.
    const unit = futuresContractByCode(terms.root)?.unit;
    if (unit) lines.push({ key: "unit", label: "Unit", value: unit });
  }
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
 * unit and at the contract's own precision (its tick's decimals), with or without a quote to hand.
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
/** The contract's tick for a price format (`MarketFormatOptions.tick`), so its prices print to it; none without terms. */
export function futuresTickOption(terms: { spec?: Pick<FuturesContractSpec, "tick"> | null } | null | undefined): { tick?: number } {
  const tick = terms?.spec?.tick;
  return tick != null && Number.isFinite(tick) && tick > 0 ? { tick } : {};
}

export function futuresSettleText(
  terms: Pick<FuturesContractTermsPayload, "settlement"> & { spec?: Pick<FuturesContractSpec, "tick"> | null },
  quote: Pick<Quote, "currency" | "instrumentType" | "priceBasis" | "providerPriceDivisor"> | null | undefined,
  movesFrom?: string | null,
): string {
  if (!terms.settlement) return FUTURES_MISSING;
  if (movesFrom && terms.settlement.date < movesFrom) return `${FUTURES_MISSING} (${movesFrom} not confirmed yet)`;
  const currency = quote?.currency;
  const options = { ...withCurrencyMinorDigits(quoteFormatOptions(quote, "FUTURE"), currency), ...futuresTickOption(terms) };
  const price = currency ? formatMarketPriceWithCurrency(terms.settlement.price, currency, options) : formatMarketPrice(terms.settlement.price, options);
  return `${price} (${terms.settlement.date})`;
}

/** The quantities a price is per, as traders abbreviate them: 467.25¢/bu for corn, $99.20/bbl for crude. */
const PER_ABBREVIATIONS: Readonly<Record<string, string>> = {
  bushel: "bu", bushels: "bu", pound: "lb", pounds: "lb", barrel: "bbl", barrels: "bbl", gallon: "gal", gallons: "gal",
};

type PricedTerms = Pick<FuturesContractTermsPayload, "spec"> & Partial<Pick<FuturesContractTermsPayload, "root">>;

/** What a root's price counts: the exchange's unit from the terms, else the catalog's (Dutch TTF gas has none from the server). */
function termsPriceUnit(terms: PricedTerms | null | undefined): string | null {
  return futuresPriceUnit(futuresContractByCode(terms?.root), terms);
}

/**
 * What a futures price is per, to follow it: "/lb" for coffee at 314.95¢/lb
 * and "/bu" for corn, where a cents sign alone says nothing of the quantity;
 * and for every energy contract, "/MWh" for Dutch TTF gas at €90.30/MWh,
 * "/MMBtu" for natural gas, "/bbl" for crude and "/gal" for gasoline and
 * heating oil, whose price means little without it. Read from the contract's
 * unit, the catalog's where the server sends none. Empty for any other price
 * in a major currency, which reads as it always has, and when the unit is not
 * in the quote's own currency.
 */
export function futuresPricePer(terms: PricedTerms | null | undefined, currency: string | null | undefined): string {
  if (!minorUnitSign(currency) && futuresContractByCode(terms?.root)?.sector !== "energy") return "";
  const per = contractPriceUnit(termsPriceUnit(terms), currency)?.split("/")[1]?.trim();
  return per ? `/${PER_ABBREVIATIONS[per.toLowerCase()] ?? per}` : "";
}

/** MMBtu in a megawatt hour: 3.412 (3,412,142 Btu). */
const MMBTU_PER_MWH = 3.412;

/**
 * A gas price per MWh as dollars per MMBtu, the unit Henry Hub gas (NG)
 * trades in, so European gas can be set against it: TTF at €90.30/MWh is
 * $30.832/MMBtu at EUR/USD 1.1650. `usdPerUnit` is one unit of the price's
 * currency in dollars. Null where the contract is not priced per MWh in that
 * currency, or the rate is unknown.
 */
export function usdPerMmbtu(
  price: number,
  terms: PricedTerms | null | undefined,
  currency: string | null | undefined,
  usdPerUnit: number | null | undefined,
): number | null {
  const unit = contractPriceUnit(termsPriceUnit(terms), currency);
  if (!unit || unit.split("/")[1]?.trim().toLowerCase() !== "mwh") return null;
  if (!Number.isFinite(price) || usdPerUnit == null || !Number.isFinite(usdPerUnit) || usdPerUnit <= 0) return null;
  return (price * usdPerUnit) / MMBTU_PER_MWH;
}

/** A per-MWh gas price in dollars per MMBtu, and the rate it was converted at: one unit of its currency in dollars. */
export interface UsdPerMmbtu {
  value: number;
  currency: string;
  usdPerUnit: number;
}

/**
 * A per-MWh gas price (Dutch TTF) in dollars per MMBtu at the rate `rate`
 * reads for its currency (USD per unit); null for any other contract, or
 * when the rate does not load.
 */
export async function loadUsdPerMmbtu(
  price: number | null | undefined,
  terms: PricedTerms | null | undefined,
  currency: string | null | undefined,
  rate: (currency: string) => Promise<number | null | undefined>,
): Promise<UsdPerMmbtu | null> {
  const code = currency?.trim().toUpperCase();
  if (price == null || !code || usdPerMmbtu(price, terms, code, 1) == null) return null;
  const usdPerUnit = code === "USD" ? 1 : await rate(code)
    .catch(logFailure("futures-contract", "Read the rate for a gas price in USD failed", null));
  const value = usdPerMmbtu(price, terms, code, usdPerUnit);
  return value == null ? null : { value, currency: code, usdPerUnit: usdPerUnit! };
}

/**
 * The dollar equivalent beside a per-MWh price, marked as a conversion and
 * with the rate it used, the way converted market caps name theirs:
 * "≈ $30.832/MMBtu at EUR/USD 1.1650".
 */
export function usdPerMmbtuText({ value, currency, usdPerUnit }: UsdPerMmbtu): string {
  return `≈ $${value.toFixed(3)}/MMBtu at ${currency}/USD ${usdPerUnit.toFixed(4)}`;
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
 * What a futures move is measured from: a session's settlement or close.
 * `session` is the date of that reference. `from` is set when the move is to
 * be measured again from that session's settlement, at that price
 * (futuresQuoteFromSettle): the source measured it from something else.
 */
export interface FuturesChangeBasis {
  kind: "settle" | "close";
  session: string;
  from?: number;
}

/** "Nov 2026", "Nov 26" or "Futures,Nov-2026"; a hyphen takes only a whole year, since "Futures,Nov-20" is 2026 cut short. */
export const CONTRACT_MONTH_NAME = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?: (\d{4}|\d{2})|-(\d{4}))$/i;
const MONTH_ABBREVIATIONS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const CONTRACT_SYMBOL = /^[A-Z0-9]+?([FGHJKMNQUVXZ])(\d{2})(?:\.[A-Z]+)?$/i;
const MONTH_CODES = "FGHJKMNQUVXZ";

/**
 * The delivery month a futures quote prices, `YYYY-MM`: from a listed
 * contract's code (ESZ26.CME), else from the month a continuous symbol's name
 * carries ("E-Mini S&P 500 Dec 26"). Null when neither says.
 */
export function futuresQuoteMonth(quote: Pick<Quote, "symbol" | "name"> | null | undefined): string | null {
  const coded = CONTRACT_SYMBOL.exec(quote?.symbol?.trim() ?? "");
  if (coded) return `20${coded[2]}-${String(MONTH_CODES.indexOf(coded[1]!.toUpperCase()) + 1).padStart(2, "0")}`;
  const named = CONTRACT_MONTH_NAME.exec(quote?.name?.trim() ?? "");
  if (!named) return null;
  const written = named[2] ?? named[3]!;
  const year = written.length === 2 ? 2000 + Number(written) : Number(written);
  return `${year}-${String(MONTH_ABBREVIATIONS.indexOf(named[1]!.toLowerCase()) + 1).padStart(2, "0")}`;
}

/** The terms a futures move is checked against: the settlement, the tick it is rounded to and the contract's month. */
export type FuturesChangeTerms = Pick<FuturesContractTermsPayload, "settlement"> & {
  spec?: Pick<FuturesContractSpec, "tick"> | null;
  deliveryMonth?: string | null;
};

/**
 * What the move a futures quote headlines is measured from, for the words
 * after it ("vs Fri 16 Oct settle", quoteChangeBasis). The move covers one
 * session, the one before its own, and is labelled by it. Its session is
 * `sessionDate` (regularSessionDisplayDate), a Saturday or Sunday being
 * Friday's, unless the print (`tradedAt`) was made after the CME Globex
 * reopen that opened a later trade date (globexPrintSession), whose move it
 * then is, whatever date the source still gives it. The session before is
 * the trade date before on the `exchange`'s published holiday calendar
 * (previousPublishedSession), so the Tuesday after Memorial Day moves from
 * Friday; a holiday Globex traded is the next trade date's.
 *
 * A reference (the price less the move) within half a tick of the settlement
 * in the terms is that settlement. Any other reference:
 * - with the session before's settlement in the terms, for the contract the
 *   quote prices (`month` is the terms' `deliveryMonth`), is measured again
 *   from it (`from`); around a roll the terms can name the month before, and
 *   the gap between the two would read as the day's move, so for another
 *   contract, or one the quote does not name, the source's move stands with
 *   no session named (null, "vs prev close");
 * - with an older settlement in the terms, is the session before's close in
 *   the overnight hours after the reopen, before that session's settlement
 *   is confirmed: Wednesday's 7,720.50 close at 23:18 UTC, "+14 vs Wed 4 Nov
 *   close", never +137.75 from Tuesday's settlement, two sessions. At any
 *   other time the terms are behind and nothing dates it (null);
 * - once the move's own session has settled, is the session before's
 *   settlement when the quote closes on its own (Gloom Cloud then measures
 *   it from the one before: CC=F's 5,155 on Fri 6 Nov 2026, "-26 vs Thu 5
 *   Nov settle"), and otherwise the session before's close;
 * - without a settlement in the terms, is the session before's close, which
 *   nothing else checks.
 * On a venue without a calendar only a settlement is named. Null without a
 * session date, a move or terms.
 */
export function futuresChangeBasis(
  terms: FuturesChangeTerms | null | undefined,
  move: { price: number; change?: number | null; sessionDate?: string | null; tradedAt?: number | null; month?: string | null } | null | undefined,
  exchange: string | null | undefined,
): FuturesChangeBasis | null {
  const dated = move?.sessionDate;
  if (!terms || !move || !dated || !isoDate.test(dated) || move.change == null) return null;
  const reference = move.price - move.change;
  if (!Number.isFinite(reference)) return null;
  const sessionBefore = (date: string) => previousPublishedSession(exchange ?? undefined, date, { closedDayRollsForward: true })?.date ?? null;
  // A print in the night after the session the source dates the move by opened the next trade date.
  const print = globexPrintSession(exchange, move.tradedAt);
  const reopened = !!print?.overnight && print.tradeDate > dated && (sessionBefore(print.tradeDate) ?? "") >= weekdayOnOrBefore(dated);
  const moveDate = reopened ? print!.tradeDate : dated;
  const session = weekdayOnOrBefore(moveDate);
  const previous = sessionBefore(moveDate);
  const settled = terms.settlement;
  if (settled && settled.date <= session && Math.abs(reference - settled.price) <= settlementTolerance(terms.spec?.tick, settled.price)) {
    return { kind: "settle", session: settled.date };
  }
  const sameContract = !!move.month && terms.deliveryMonth?.slice(0, 7) === move.month;
  if (settled && previous && settled.date === previous) {
    return sameContract && Number.isFinite(move.price) ? { kind: "settle", session: previous, from: settled.price } : null;
  }
  // The move's own session settled, and the quote closes on that settlement: Gloom Cloud measures it from the one before.
  if (settled && previous && settled.date === session && sameContract
    && Math.abs(move.price - settled.price) <= settlementTolerance(terms.spec?.tick, settled.price)) {
    return { kind: "settle", session: previous };
  }
  if (settled && previous && settled.date < previous) return print?.overnight && print.tradeDate === moveDate ? { kind: "close", session: previous } : null;
  return previous ? { kind: "close", session: previous } : null;
}

/** A listed contract as code and month: "NGX26 (Nov 2026)". */
function contractWithMonth(contract: { contract: string; contractSymbol: string; deliveryMonth: string }): string {
  const month = deliveryMonthLabel(contract.deliveryMonth);
  const code = futuresContractCode(contract);
  return month ? `${code} (${month})` : code;
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
    && (row.settlement === "physical" || row.settlement === "cash")
    && (row.settlesTo === undefined || row.settlesTo === null || typeof row.settlesTo === "string");
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
  /** `batch`: one of many asked at once (a futures board's rows), to go out in a batch request with them. */
  options: { batch?: boolean } = {},
): Promise<FuturesContractTermsPayload> {
  // The terms are the contract's wherever it is listed: GC=F:CMX asks for GC=F.
  return validateFuturesContractTerms(await client.getCloudFuturesContract(parsePublicTickerKey(symbol).symbol, options));
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
