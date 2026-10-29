import type { CedearRatio, DepositaryPair, Fundamentals, Quote } from "../types/financials";
import { canonicalExchange, parsePublicTickerKey } from "../utils/exchanges";
import { formatNumber } from "../utils/format";
import { formatUtcDayTime } from "../utils/utc-time";
import { heldCurrencyUnit } from "../utils/currency-units";
import { regularSessionCloseOn } from "./market/freshness";
import { getRegularSessionDisplay, regularSessionDisplayDate } from "./market/status";

/**
 * A depositary receipt beside its home listing: the ratio Gloom Cloud serves
 * on both lines, the two prices, and the dollar rate they imply. For GGAL
 * (1 ADR = 10 shares) at $37.91 and GGAL.BA at ARS 6,260, 6,260 × 10 / 37.91
 * = 1,651 pesos a dollar: the rate paid by buying the shares in pesos and
 * selling the receipt abroad, the CCL rate, against an official 1,529.
 */

/** A served pair, when it is whole: a receipt, a positive ratio, at least one home line. */
function readDepositaryPair(value: unknown): DepositaryPair | null {
  if (!value || typeof value !== "object") return null;
  const { receipt, ratio, ordinary } = value as Partial<DepositaryPair>;
  if (typeof receipt !== "string" || !receipt.trim()) return null;
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0) return null;
  const lines = Array.isArray(ordinary) ? ordinary.filter((line): line is string => typeof line === "string" && !!line.trim()) : [];
  return lines.length > 0 ? { receipt: receipt.trim().toUpperCase(), ratio, ordinary: lines } : null;
}

type PairRecords = { quote?: Pick<Quote, "depositaryPair" | "isDepositaryReceipt"> | null; fundamentals?: Pick<Fundamentals, "depositaryPair" | "isDepositaryReceipt"> | null };

/** The pair a listing's records name: the quote's, else the fundamentals'. */
export function listingDepositaryPair(records: PairRecords | null | undefined): DepositaryPair | null {
  return readDepositaryPair(records?.quote?.depositaryPair) ?? readDepositaryPair(records?.fundamentals?.depositaryPair);
}

/** Whether the listing is the pair's receipt rather than one of its home lines. */
export function isReceiptSide(records: PairRecords | null | undefined): boolean {
  return (records?.quote?.isDepositaryReceipt ?? records?.fundamentals?.isDepositaryReceipt) === true;
}

/** `10`, `0.25`: a ratio without float noise. */
export function ratioCount(ratio: number): string {
  return Number.isInteger(ratio) ? String(ratio) : String(Number(ratio.toPrecision(6)));
}

type CedearRecords = { quote?: Pick<Quote, "cedearRatio"> | null; fundamentals?: Pick<Fundamentals, "cedearRatio"> | null };

const positiveCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

/** A served CEDEAR ratio, when it is whole. */
function readCedearRatio(value: unknown): CedearRatio | null {
  if (!value || typeof value !== "object") return null;
  const ratio = value as Partial<CedearRatio>;
  if (typeof ratio.listing !== "string" || !ratio.listing.trim()) return null;
  if (typeof ratio.company !== "string" || !ratio.company.trim()) return null;
  if (!positiveCount(ratio.receipts) || !positiveCount(ratio.shares)) return null;
  return ratio as CedearRatio;
}

/** The CEDEAR ratio a listing's records state: the quote's, else the fundamentals'. */
export function listingCedearRatio(records: CedearRecords | null | undefined): CedearRatio | null {
  return readCedearRatio(records?.quote?.cedearRatio) ?? readCedearRatio(records?.fundamentals?.cedearRatio);
}

/** A CEDEAR's ratio in its company's shares: `20 AAPL:BYMA = 1 Apple Inc. share`. */
export function cedearRatioText(ratio: CedearRatio): string {
  return `${ratioCount(ratio.receipts)} ${ratio.listing} = ${ratioCount(ratio.shares)} ${ratio.company.trim()} share${ratio.shares === 1 ? "" : "s"}`;
}

/** What a home line says of its receipt: `1 GGAL ADR = 10 of these shares`, and `1 of these shares` for one. */
function homeLineRatioText(pair: DepositaryPair): string {
  return `1 ${pair.receipt} ADR = ${ratioCount(pair.ratio)} of these shares`;
}

/**
 * The ratio as a listing's report states it, from its side of the pair:
 * `1 ADR = 10 ordinary shares of GGAL.BA` on the receipt, `1 GGAL ADR = 10
 * of these shares` on a home line.
 */
export function depositaryPairText(pair: DepositaryPair, receiptSide: boolean): string {
  if (!receiptSide) return homeLineRatioText(pair);
  return `1 ADR = ${ratioCount(pair.ratio)} ordinary share${pair.ratio === 1 ? "" : "s"} of ${pair.ordinary.join(" / ")}`;
}

/** A price as the comparison reads it, with when it was observed. */
export interface PairPriceInput {
  symbol: string;
  price: number;
  currency: string;
  /** When the price was set: the last trade, or the close of a session that ended. */
  observedAt: number | null;
  /** The listing's regular session is trading. */
  open: boolean;
}

/**
 * A listing's regular-session price (an after-hours print never moves it),
 * observed at its last trade while the session runs, and once it is over at
 * that trade or the close, whichever came first.
 */
export function pairPriceInput(symbol: string, quote: Quote | null | undefined): PairPriceInput | null {
  const quoted = getRegularSessionDisplay(quote)?.price;
  if (!quote || quoted == null || !Number.isFinite(quoted) || quoted <= 0 || !quote.currency) return null;
  // A price in a minor unit (pence, GBp) is read in its currency, as the dollar rate is served for it.
  const unit = heldCurrencyUnit(quote.currency);
  if (!unit.currency) return null;
  const price = quoted / unit.divisor;
  const open = quote.marketState === "REGULAR";
  const lastUpdated = Number.isFinite(quote.lastUpdated) && quote.lastUpdated > 0 ? quote.lastUpdated : null;
  const sessionDate = open ? null : regularSessionDisplayDate(quote);
  const close = sessionDate ? regularSessionCloseOn(quote.listingExchangeName || quote.exchangeName, sessionDate) : null;
  const observedAt = close != null && (lastUpdated == null || lastUpdated > close) ? close : lastUpdated;
  return { symbol, price, currency: unit.currency, observedAt, open };
}

/** The home currency's dollar rate (units of it per USD) and when it was read. */
export interface PairSpotInput {
  rate: number;
  observedAt: number | null;
}

/** The spot from a USD value of one unit of the currency, as exchange rates are served. */
export function spotFromUsdValue(usdPerUnit: number | null | undefined, observedAt?: number | null): PairSpotInput | null {
  if (usdPerUnit == null || !Number.isFinite(usdPerUnit) || usdPerUnit <= 0) return null;
  return { rate: 1 / usdPerUnit, observedAt: observedAt ?? null };
}

export interface DepositaryPairComparison {
  ratio: number;
  receipt: PairPriceInput;
  home: PairPriceInput;
  /** Units of the home currency per dollar the two prices imply: home × ratio / receipt. */
  impliedFx: number;
  spot: PairSpotInput | null;
  /** The receipt over the home shares it holds at spot, in percent: spot / implied - 1. */
  premiumPercent: number | null;
  /** Said when the two prices were not set together; null when they were. */
  timingNote: string | null;
}

/** Inputs this far apart are from different times. */
const SAME_TIME_MS = 30 * 60_000;

/** `14 h 30 min`, `2 days 6 h`. */
function gapText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return [`${days} day${days === 1 ? "" : "s"}`, hours ? `${hours} h` : ""].filter(Boolean).join(" ");
  return [hours ? `${hours} h` : "", rest || !hours ? `${rest} min` : ""].filter(Boolean).join(" ");
}

/** `Fri 23 Oct 20:00 UTC`. */
export function pairTimeText(time: number, now = Date.now()): string {
  return `${formatUtcDayTime({ time, dateOnly: false }, now)} UTC`;
}

function timingNote(receipt: PairPriceInput, home: PairPriceInput, now: number): string | null {
  if (receipt.open && home.open) return null;
  if (receipt.observedAt == null || home.observedAt == null) return null;
  const gap = Math.abs(receipt.observedAt - home.observedAt);
  if (receipt.open !== home.open) {
    const [closed, trading] = receipt.open ? [home, receipt] : [receipt, home];
    return `${closed.symbol} is closed, its price from ${pairTimeText(closed.observedAt!, now)}, while ${trading.symbol} trades: the prices are ${gapText(gap)} apart.`;
  }
  if (gap <= SAME_TIME_MS) return null;
  const [first, second] = home.observedAt <= receipt.observedAt ? [home, receipt] : [receipt, home];
  return `Both markets are closed: ${first.symbol} from ${pairTimeText(first.observedAt!, now)}, ${second.symbol} from ${pairTimeText(second.observedAt!, now)}, ${gapText(gap)} apart.`;
}

/** The comparison, or null when the receipt is not priced in dollars or a price is missing. */
export function compareDepositaryPair(
  ratio: number,
  receipt: PairPriceInput | null,
  home: PairPriceInput | null,
  spot: PairSpotInput | null,
  now = Date.now(),
): DepositaryPairComparison | null {
  if (!receipt || !home || !(ratio > 0) || receipt.currency !== "USD") return null;
  const impliedFx = (home.price * ratio) / receipt.price;
  if (!Number.isFinite(impliedFx) || impliedFx <= 0) return null;
  const premiumPercent = spot ? (spot.rate / impliedFx - 1) * 100 : null;
  return { ratio, receipt, home, impliedFx, spot, premiumPercent, timingNote: timingNote(receipt, home, now) };
}

/** `1,651.28`, `28.4942`, `0.890625`: a dollar rate to its useful digits. */
export function formatPairRate(rate: number): string {
  const size = Math.abs(rate);
  return formatNumber(rate, size >= 100 ? 2 : size >= 1 ? 4 : 6);
}

/** `+14.3% premium`, `-7.4% discount`. */
export function premiumText(percent: number): string {
  const rounded = Math.round(percent * 10) / 10;
  if (rounded === 0) return "0.0% at par";
  return `${rounded > 0 ? "+" : ""}${rounded.toFixed(1)}% ${rounded > 0 ? "premium" : "discount"}`;
}

/** `USD/ARS`: the home currency's dollar pair, as `fx` names it. */
export function dollarPairLabel(currency: string): string {
  return `USD/${currency}`;
}

/** What the served dollar rate of a currency is, where it is not the one market rate: the peso's official one. */
export function spotRateKind(currency: string): string | null {
  return currency.trim().toUpperCase() === "ARS" ? "official wholesale" : null;
}

/**
 * Buenos Aires lists a share's dollar lines under its peso symbol with a
 * letter added: D settles in dollars at home (the MEP line), C abroad (the CCL
 * line). Null for a listing elsewhere.
 */
export function bymaDollarLineKeys(homeKey: string): { mep: string; ccl: string } | null {
  const { symbol, exchange } = parsePublicTickerKey(homeKey);
  const suffix = /^(.+)\.BA$/i.exec(homeKey.trim());
  if (suffix) return { mep: `${suffix[1]!.toUpperCase()}D.BA`, ccl: `${suffix[1]!.toUpperCase()}C.BA` };
  if (canonicalExchange(exchange) !== "BYMA") return null;
  return { mep: `${symbol.toUpperCase()}D.BA`, ccl: `${symbol.toUpperCase()}C.BA` };
}

/** The receipt the peso's implied dollar rates are read through: Galicia, the most traded Argentine pair. */
export const PESO_REFERENCE_RECEIPT = "GGAL";

type ImpliedDollarRateKind = "ccl-receipt" | "ccl-line" | "mep-line";

/** A dollar rate a pair of prices implies, with the prices it came from. */
export interface ImpliedDollarRate {
  kind: ImpliedDollarRateKind;
  /** `CCL via GGAL ADR`. */
  label: string;
  /** Pesos per dollar. */
  rate: number;
  /** `6,260 × 10 / 37.91`. */
  formula: string;
  inputs: PairPriceInput[];
}

const PESO_RATE_LABELS: Record<ImpliedDollarRateKind, (symbol: string) => string> = {
  "ccl-receipt": (receipt) => `CCL via ${receipt} ADR`,
  "ccl-line": (line) => `CCL via ${line}`,
  "mep-line": (line) => `MEP via ${line}`,
};

/**
 * The peso's market dollar rates from one Argentine pair: the CCL rate its
 * receipt implies (home × ratio / receipt) and the one its Buenos Aires CCL
 * line implies (home / C line), and the MEP rate of its D line (home / D
 * line). A rate whose prices are missing is left out, as is the receipt's
 * without a ratio on record.
 */
export function pesoImpliedRates(
  receiptRatio: number | null,
  inputs: { home: PairPriceInput | null; receipt: PairPriceInput | null; mep: PairPriceInput | null; ccl: PairPriceInput | null },
): ImpliedDollarRate[] {
  const { home } = inputs;
  if (!home || home.currency !== "ARS") return [];
  const rates: ImpliedDollarRate[] = [];
  const price = (input: PairPriceInput) => formatNumber(input.price, input.price >= 100 ? 2 : 4).replace(/\.?0+$/, "");
  const add = (kind: ImpliedDollarRateKind, dollar: PairPriceInput | null, ratio: number | null) => {
    if (!dollar || dollar.currency !== "USD" || ratio == null || !(ratio > 0)) return;
    const rate = (home.price * ratio) / dollar.price;
    if (!Number.isFinite(rate) || rate <= 0) return;
    rates.push({
      kind,
      label: PESO_RATE_LABELS[kind](dollar.symbol),
      rate,
      formula: `${price(home)}${ratio === 1 ? "" : ` × ${ratioCount(ratio)}`} / ${price(dollar)}`,
      inputs: [home, dollar],
    });
  };
  add("ccl-receipt", inputs.receipt, receiptRatio);
  add("ccl-line", inputs.ccl, 1);
  add("mep-line", inputs.mep, 1);
  return rates;
}
