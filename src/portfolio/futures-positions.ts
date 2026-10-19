import type { FuturesContractSpec, FuturesContractTermsPayload } from "../api-client/futures-curve";
import type { ActiveQuoteDisplay } from "../market-data/market/status";
import type { PricePoint } from "../types/financials";
import type { TickerPosition, TickerRecord } from "../types/ticker";
import { classifyInstrumentType } from "../tickers/instrument-kind";
import { parsePublicTickerKey } from "../utils/exchanges";

/**
 * A futures position is held in contracts. One contract is worth its price
 * times the contract's multiplier, which comes from the exchange's terms the
 * way `quote` states them (Size, Point Value), and is stored on the lot as an
 * option's is (`TickerPosition.multiplier`), so every reader values it alike.
 * A lot whose contract size is unknown is not valued at all: a price per
 * ounce times a count of contracts is no value.
 */

/** What one contract counts: the price times `multiplier` is one contract's value, in the quote's currency. */
export interface FuturesContractSize {
  multiplier: number;
  /** One contract as the exchange words it, shortened for a row: "100 oz", "5,000 bushels", "$50 x index". */
  size: string;
}

/** A future's latest confirmed exchange settlement, and the one before it where the daily history has it. */
export interface FuturesSettlement {
  price: number;
  /** The session it settles, YYYY-MM-DD. */
  date: string;
  previous: number | null;
}

/** What a portfolio reads from a future's terms: its contract size and its settlement. */
export interface PortfolioFuturesTerms {
  size: FuturesContractSize | null;
  settlement: FuturesSettlement | null;
}

/** A grain or a soft quotes in US cents, so a dollar point value is a hundred of its price units. */
const US_CENTS_UNIT = /^\s*US\s+cents?\b/i;

/** Whether a ticker is a futures contract (GC=F, GCZ26, CL1 typed as a future). */
export function isFuturesTicker(ticker: Pick<TickerRecord, "metadata">): boolean {
  return classifyInstrumentType(ticker.metadata.assetCategory) === "future"
    || /=F$/i.test(parsePublicTickerKey(ticker.metadata.ticker).symbol.trim());
}

/**
 * One contract's multiplier and size from the exchange's terms: GC's $100
 * point value is 100 oz a contract, ZC's $50 a cent is 5,000 bushels. Null
 * without terms, so the size is never guessed.
 */
export function futuresContractSize(spec: Pick<FuturesContractSpec, "unit" | "size" | "pointValue"> | null | undefined): FuturesContractSize | null {
  if (!spec || !(typeof spec.pointValue === "number" && Number.isFinite(spec.pointValue) && spec.pointValue > 0)) return null;
  const multiplier = US_CENTS_UNIT.test(spec.unit) ? spec.pointValue * 100 : spec.pointValue;
  return { multiplier: Number(multiplier.toPrecision(12)), size: spec.size.replace(/\btroy oz\b/, "oz").trim() };
}

/** A count of contracts and what each one is: "1,000 × 100 oz", or the count alone when the size is unknown. */
export function futuresQuantityText(quantity: string, size: Pick<FuturesContractSize, "size"> | null | undefined): string {
  return size?.size && quantity !== "—" ? `${quantity} × ${size.size}` : quantity;
}

function hasMultiplier(position: Pick<TickerPosition, "multiplier">): boolean {
  return typeof position.multiplier === "number" && Number.isFinite(position.multiplier) && position.multiplier > 0;
}

/**
 * The ticker with each lot that states no contract size given the one its
 * terms do. Lots entered before positions were sized by contract, and lots a
 * team collection sends, carry none. The same record when nothing changes.
 */
export function withFuturesContractSize(ticker: TickerRecord, size: FuturesContractSize | null | undefined): TickerRecord {
  if (!size || !isFuturesTicker(ticker) || ticker.metadata.positions.every(hasMultiplier)) return ticker;
  return {
    ...ticker,
    metadata: {
      ...ticker.metadata,
      positions: ticker.metadata.positions.map((position) => hasMultiplier(position) ? position : { ...position, multiplier: size.multiplier }),
    },
  };
}

const DAY_MS = 86_400_000;

/**
 * The trading date a daily bar stands for. Bars are dated at midnight, UTC
 * from Gloom Cloud but local where a runtime rebuilt the date, so the nearest
 * UTC midnight is the bar's day either way.
 */
function dailyBarDay(time: number): string {
  return new Date(Math.round(time / DAY_MS) * DAY_MS).toISOString().slice(0, 10);
}

/** A session's close and the settlement it is checked against agree to well inside a tick. */
const SETTLEMENT_TOLERANCE = 1e-5;
/** Daily bars of a trading week: a longer gap before a settlement is not the session before it. */
const MAX_SESSION_GAP_DAYS = 5;

/**
 * The confirmed settlement before the one of `date`, from a daily history
 * whose bar for `date` closes at `settlement`: a close the exchange has not
 * settled is skipped. Null when the history has no such bar, or more than one
 * for the day, as weekly or intraday bars do, or when the bar before is
 * further back than a session, so a move is never measured from another
 * cadence's close.
 */
export function previousFuturesSettlement(
  history: readonly PricePoint[] | null | undefined,
  date: string,
  settlement?: number,
): number | null {
  const bars: { day: string; close: number }[] = [];
  for (const point of history ?? []) {
    const time = point.date instanceof Date ? point.date.getTime() : new Date(point.date).getTime();
    if (!Number.isFinite(time) || point.unsettled || !Number.isFinite(point.close) || point.close <= 0) continue;
    bars.push({ day: dailyBarDay(time), close: point.close });
  }
  bars.sort((left, right) => left.day.localeCompare(right.day));
  const index = bars.findIndex((bar) => bar.day === date);
  const own = bars[index];
  const before = bars[index - 1];
  if (!own || !before || bars[index + 1]?.day === date) return null;
  if (settlement != null && Math.abs(own.close - settlement) > Math.abs(settlement) * SETTLEMENT_TOLERANCE) return null;
  const gap = (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${before.day}T00:00:00Z`)) / DAY_MS;
  return gap <= MAX_SESSION_GAP_DAYS ? before.close : null;
}

/** What a portfolio reads from a future's terms, with the settlement before the latest when the history has it. */
export function portfolioFuturesTerms(
  terms: Pick<FuturesContractTermsPayload, "spec" | "settlement"> | null | undefined,
  history?: readonly PricePoint[] | null,
): PortfolioFuturesTerms {
  const settlement = terms?.settlement && Number.isFinite(terms.settlement.price) && terms.settlement.price > 0
    ? {
      price: terms.settlement.price,
      date: terms.settlement.date,
      previous: previousFuturesSettlement(history, terms.settlement.date, terms.settlement.price),
    }
    : null;
  return { size: futuresContractSize(terms?.spec), settlement };
}

/**
 * A future valued at its settlement, as `quote` gives it, with the move from
 * the settlement before. The quote's own move is the Globex session's, from
 * this settlement or an earlier one, so without the settlement before from the
 * daily history the move is unknown rather than borrowed.
 */
export function futuresSettlementDisplay(settlement: FuturesSettlement): ActiveQuoteDisplay {
  const reference = settlement.previous;
  if (reference == null || !(reference > 0)) return { price: settlement.price };
  const change = settlement.price - reference;
  return { price: settlement.price, change, changePercent: (change / reference) * 100 };
}

/**
 * Every ticker with its futures lots sized by their terms (withFuturesContractSize),
 * by symbol. The same array, and the same records, where nothing changes, so
 * rows keyed by their records keep them.
 */
export function withFuturesContractSizes(
  tickers: readonly TickerRecord[],
  terms: ReadonlyMap<string, Pick<PortfolioFuturesTerms, "size">> | null | undefined,
): TickerRecord[] {
  if (!terms || terms.size === 0) return tickers as TickerRecord[];
  let changed = false;
  const sized = tickers.map((ticker) => {
    const next = withFuturesContractSize(ticker, terms.get(ticker.metadata.ticker)?.size);
    changed ||= next !== ticker;
    return next;
  });
  return changed ? sized : tickers as TickerRecord[];
}
