import type { HeadlessBundleResult, HeadlessPaneColumn } from "../../../types/headless";
import { formatPercent } from "../../../utils/format";
import type { DividendData } from "./client";
import { formatDividendYield } from "./view";

/** One symbol of `fn DVD A B C`: what DVD read for it, or why it read nothing. */
export type DividendRankingEntry =
  | { symbol: string; data: DividendData }
  | { symbol: string; error: string };

const isoDay = (date: Date | null | undefined): string | null => date ? date.toISOString().slice(0, 10) : null;

/** A ratio to the sixth decimal, a percent to the fourth (0.035396 is 3.5396%), so an export carries no float noise. */
export function roundedRatio(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

/**
 * The pay date of the next distribution, when one is declared: the earliest
 * declared row still to pay, else the upcoming pay date the source states.
 * Past distributions carry ex-dates only, so a paid one has none.
 */
function declaredPayDate(data: Pick<DividendData, "declared" | "metrics">, now = new Date()): string | null {
  const today = now.toISOString().slice(0, 10);
  const declared = (data.declared ?? []).map((row) => row.payDate).filter((day): day is string => !!day && day >= today).sort()[0];
  return declared ?? isoDay(data.metrics.nextPayDate);
}

/**
 * What a row is missing, as its Note says: a read that failed, or one that
 * came back without its cash history or its summary (forward rate, payout,
 * pay date). Null for a whole read, which a non-payer's is too.
 */
function incompleteNote(entry: DividendRankingEntry): string | null {
  if ("error" in entry) return "not read";
  const { historyError, summaryError } = entry.data;
  if (historyError && summaryError) return "no cash history or summary";
  if (historyError) return "no cash history";
  return summaryError ? "no summary" : null;
}

/** What a row is missing, in full, for the report's errors; null for a whole read. */
function incompleteReason(entry: DividendRankingEntry): string | null {
  if ("error" in entry) return entry.error;
  const reasons = [entry.data.historyError, entry.data.summaryError].filter((reason): reason is string => !!reason);
  return reasons.length > 0 ? reasons.join(" ") : null;
}

/**
 * Rows ranked by trailing yield, highest first; a symbol without one, then
 * one that failed, last, in the order typed. Yield and growth are ratios, so
 * listings in different currencies rank together.
 */
function rankDividendEntries(entries: readonly DividendRankingEntry[], now = new Date()): Record<string, unknown>[] {
  const rows = entries.map((entry, index) => {
    if ("error" in entry) {
      return { index, failed: true, trailingYield: null, row: { symbol: entry.symbol, currency: null, price: null, priceAsOf: null, trailingYield: null, forwardYield: null,
        payoutRatio: null, growth1Y: null, growth3Y: null, lastExDate: null, payDate: null, frequency: null, note: incompleteNote(entry), error: entry.error } };
    }
    const { data } = entry;
    const metrics = data.metrics;
    return {
      index,
      failed: false,
      // Ranked on the measured yield, rounded only in the row, so two that round alike still rank higher first.
      trailingYield: metrics.trailingYield,
      row: {
        symbol: entry.symbol,
        currency: data.currency ?? null,
        price: data.price,
        // When the price the yields are over is from: each row's export is dated by it.
        priceAsOf: data.price != null ? data.priceAsOf ?? null : null,
        trailingYield: roundedRatio(metrics.trailingYield),
        forwardYield: roundedRatio(metrics.forwardYield),
        payoutRatio: roundedRatio(metrics.payoutRatio),
        growth1Y: roundedRatio(metrics.growth1Y),
        growth3Y: roundedRatio(metrics.growth3Y),
        lastExDate: isoDay(metrics.lastExDividendDate),
        payDate: declaredPayDate(data, now),
        frequency: metrics.paymentFrequency,
        note: incompleteNote(entry),
        error: incompleteReason(entry),
      },
    };
  });
  const yieldOf = (value: number | null) => value != null && Number.isFinite(value) ? value : null;
  return rows.sort((left, right) => {
    const a = yieldOf(left.trailingYield);
    const b = yieldOf(right.trailingYield);
    if (a != null && b != null && a !== b) return b - a;
    if ((a == null) !== (b == null)) return a == null ? 1 : -1;
    return Number(left.failed) - Number(right.failed) || left.index - right.index;
  }).map(({ row }) => row);
}

const ratio = (value: unknown) => formatDividendYield(typeof value === "number" ? value : null);
const growth = (value: unknown) => formatPercent(typeof value === "number" ? value : undefined);
const day = (value: unknown) => typeof value === "string" && value ? value : "—";

const RANKING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker", shrink: false },
  { key: "trailingYield", header: "Yield TTM", align: "right", format: ratio,
    description: "Cash distributions with ex-dates in the past twelve months over the reference price." },
  { key: "forwardYield", header: "Fwd yield", align: "right", format: ratio, stackPriority: 1,
    description: "Indicated annual rate over the reference price; none once the dividend has stopped." },
  { key: "payoutRatio", header: "Payout", align: "right", format: ratio,
    description: "Trailing twelve-month dividends over trailing twelve-month diluted EPS." },
  { key: "growth1Y", header: "1Y growth", align: "right", format: growth,
    description: "Trailing twelve-month cash per share against a year earlier." },
  { key: "growth3Y", header: "3Y CAGR", align: "right", format: growth,
    description: "Compound annual growth of trailing twelve-month cash per share over three years." },
  { key: "lastExDate", header: "Last ex", format: day, shrink: false },
  { key: "payDate", header: "Pay date", format: day, shrink: false, stackPriority: 2,
    description: "Pay date of the next declared distribution; past distributions carry ex-dates only." },
];

/** Shown once a row is incomplete, so a missing figure never reads as a non-payer's. */
const NOTE_COLUMN: HeadlessPaneColumn = { key: "note", header: "Note", format: (value) => typeof value === "string" ? value : "",
  description: "What the read of this ticker is missing: not read, no cash history (yields and growth), or no summary (forward yield, payout, pay date)." };

/** `fn DVD A B C`: one table of every symbol, ranked by trailing yield. */
export function projectDividendRanking(entries: readonly DividendRankingEntry[], now = new Date()): HeadlessBundleResult {
  const rows = rankDividendEntries(entries, now);
  // A failed read, or one without its cash history or summary, is as incomplete as single-ticker DVD says it is.
  const incomplete = entries.flatMap((entry) => {
    const reason = incompleteReason(entry);
    return reason ? [{ symbol: entry.symbol, reason }] : [];
  });
  return {
    ...(incomplete.length > 0 ? {
      complete: false,
      unavailableSymbols: incomplete.map((entry) => entry.symbol),
      errors: incomplete.map((entry) => `${entry.symbol}: ${entry.reason}`),
    } : {}),
    sections: [{
      title: "Ranked by trailing yield; payout is over TTM diluted EPS",
      columns: incomplete.length > 0 ? [...RANKING_COLUMNS, NOTE_COLUMN] : RANKING_COLUMNS,
      rows,
      // Every figure is a percent; each exported row names its ticker and the time of the price its yields are over.
      unit: "pct",
      rowSymbolKey: "symbol",
      rowAsOfKey: "priceAsOf",
    }],
    metadata: {
      rankedBy: "trailingYield",
      symbols: entries.map((entry) => entry.symbol),
      yieldMethod: "Cash distributions with ex-dates in the preceding 12 months, one payment per period for a regular cadence, divided by the reference share price, in the listing's own currency.",
      payoutMethod: "Trailing twelve-month dividends over trailing twelve-month diluted EPS, as the source states it.",
      growthMethod: "Trailing twelve-month cash per share now against one and three years before; 3Y is a compound annual rate.",
      payDateMethod: "Pay date of the next declared distribution; past distributions carry ex-dates only.",
    },
  };
}
