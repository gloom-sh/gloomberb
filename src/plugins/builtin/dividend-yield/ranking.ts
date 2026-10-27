import type { HeadlessBundleResult, HeadlessPaneColumn } from "../../../types/headless";
import { formatPercent } from "../../../utils/format";
import type { DividendData } from "./client";
import { formatDividendYield, growthPaymentsDetail, PAYOUT_NOT_MEANINGFUL, trailingPaymentsText } from "./view";
import type { FundBondFacts } from "../../../api-client/fund-facts";
import { NOT_SEC_YIELD } from "../../../market-data/bond-funds";

/**
 * One symbol of `fn DVD A B C`: what DVD read for it, or why it read nothing.
 * A bond fund's facts give its SEC yield, which its cash yields are not.
 */
export type DividendRankingEntry =
  | { symbol: string; data: DividendData; bond?: FundBondFacts | null }
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

/** How a row's trailing yield was counted, when its year holds fewer payments than its cadence pays; null otherwise. */
function yieldBasis(entry: DividendRankingEntry): string | null {
  const counted = "data" in entry ? trailingPaymentsText(entry.data.metrics.trailingPayments, { cadence: true }) : null;
  return counted ? `counts ${counted}` : null;
}

/** What a row is missing, in full, for the report's errors; null for a whole read. */
function incompleteReason(entry: DividendRankingEntry): string | null {
  if ("error" in entry) return entry.error;
  const reasons = [entry.data.historyError, entry.data.summaryError].filter((reason): reason is string => !!reason);
  return reasons.length > 0 ? reasons.join(" ") : null;
}

/** Whether a ranked symbol is a bond fund, whose yields are then distribution yields beside its SEC yield. */
const isBondEntry = (entry: DividendRankingEntry) => "data" in entry && !!entry.bond;

/** A bond fund's SEC yield as a ratio, as the ranking's other yields are, with its own date; empty for any other row. */
function secYieldFields(entry: DividendRankingEntry): { secYield: number | null; secYieldAsOf: string | null } {
  const sec = "data" in entry ? entry.bond?.secYield : null;
  return { secYield: sec ? roundedRatio(sec.value / 100) : null, secYieldAsOf: sec?.asOf ?? null };
}

/**
 * Rows ranked by trailing yield, highest first; a symbol without one, then
 * one that failed, last, in the order typed. Yield and growth are ratios, so
 * listings in different currencies rank together. With a bond fund among
 * them, each row carries the SEC yield after its forward yield.
 */
function rankDividendEntries(entries: readonly DividendRankingEntry[], now = new Date()): Record<string, unknown>[] {
  const bonds = entries.some(isBondEntry);
  const rows = entries.map((entry, index) => {
    if ("error" in entry) {
      return { index, failed: true, trailingYield: null, row: { symbol: entry.symbol, currency: null, price: null, priceAsOf: null, trailingYield: null, forwardYield: null,
        ...bonds ? secYieldFields(entry) : {}, payoutRatio: null, growth1Y: null, growth3Y: null, lastExDate: null, payDate: null, frequency: null, note: incompleteNote(entry), error: entry.error } };
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
        ...bonds ? secYieldFields(entry) : {},
        payoutRatio: roundedRatio(metrics.payoutRatio),
        payoutNotMeaningful: metrics.payoutNotMeaningful === true,
        growth1Y: roundedRatio(metrics.growth1Y),
        growth3Y: roundedRatio(metrics.growth3Y),
        // Set when a year the figure compares is short of the cadence's payments: the figure is then n/a.
        ...metrics.growth1YPayments ? { growth1YPayments: growthPaymentsDetail(metrics.growth1YPayments) } : {},
        ...metrics.growth3YPayments ? { growth3YPayments: growthPaymentsDetail(metrics.growth3YPayments) } : {},
        lastExDate: isoDay(metrics.lastExDividendDate),
        payDate: declaredPayDate(data, now),
        frequency: metrics.paymentFrequency,
        note: incompleteNote(entry),
        yieldBasis: yieldBasis(entry),
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
/** A growth figure, or n/a when one of its years is short (the row's `<key>Payments`). */
const growth = (key: "growth1Y" | "growth3Y") => (value: unknown, row: Record<string, unknown>) =>
  typeof value !== "number" && typeof row[`${key}Payments`] === "string" ? "n/a" : formatPercent(typeof value === "number" ? value : undefined);
const day = (value: unknown) => typeof value === "string" && value ? value : "—";

const RANKING_COLUMNS: HeadlessPaneColumn[] = [
  { key: "symbol", header: "Ticker", shrink: false },
  { key: "trailingYield", header: "Yield TTM", align: "right", format: ratio,
    description: "Cash distributions with ex-dates in the past twelve months over the reference price." },
  { key: "forwardYield", header: "Fwd yield", align: "right", format: ratio, stackPriority: 1,
    description: "Indicated annual rate over the reference price; none once the dividend has stopped." },
  { key: "payoutRatio", header: "Payout", align: "right",
    // CSV and NDJSON say `n/m` where JSON has null; the text report draws `N/M` as P/E does.
    format: (value, row) => row.payoutNotMeaningful === true ? PAYOUT_NOT_MEANINGFUL.toLowerCase() : ratio(value),
    textFormat: (value, row) => row.payoutNotMeaningful === true ? PAYOUT_NOT_MEANINGFUL : ratio(value),
    description: "Trailing twelve-month dividends over trailing twelve-month diluted EPS; N/M when that EPS is zero or negative." },
  { key: "growth1Y", header: "1Y growth", align: "right", format: growth("growth1Y"),
    description: "Trailing twelve-month cash per share against a year earlier; n/a when either year holds fewer payments than the cadence pays." },
  { key: "growth3Y", header: "3Y CAGR", align: "right", format: growth("growth3Y"),
    description: "Compound annual growth of trailing twelve-month cash per share over three years; n/a when either year holds fewer payments than the cadence pays." },
  { key: "lastExDate", header: "Last ex", format: day, shrink: false },
  { key: "payDate", header: "Pay date", format: day, shrink: false, stackPriority: 2,
    description: "Pay date of the next declared distribution; past distributions carry ex-dates only." },
];

/** Shown after the forward yield once a bond fund is ranked: its sponsor's SEC yield, and its date. */
const SEC_YIELD_COLUMNS: HeadlessPaneColumn[] = [
  { key: "secYield", header: "SEC yield", align: "right", format: ratio,
    description: "A bond fund's 30-day SEC yield as its sponsor publishes it; its Yield TTM and Fwd yield are distribution yields, not its SEC yield. Blank for any other listing." },
  { key: "secYieldAsOf", header: "SEC as of", format: day, shrink: false, stackPriority: 3,
    description: "The date the sponsor gives its SEC yield as of." },
];

/** The ranking's columns: a bond fund's SEC yield after the forward yield once one is ranked. */
function rankingColumns(bonds: boolean): HeadlessPaneColumn[] {
  if (!bonds) return RANKING_COLUMNS;
  const after = RANKING_COLUMNS.findIndex((column) => column.key === "forwardYield") + 1;
  return [...RANKING_COLUMNS.slice(0, after), ...SEC_YIELD_COLUMNS, ...RANKING_COLUMNS.slice(after)];
}

/** Shown once a row is incomplete, so a missing figure never reads as a non-payer's. */
const NOTE_COLUMN: HeadlessPaneColumn = { key: "note", header: "Note", format: (value) => typeof value === "string" ? value : "",
  description: "What the read of this ticker is missing: not read, no cash history (yields and growth), or no summary (forward yield, payout, pay date)." };

/** Shown once a regular payer's trailing year holds fewer payments than its cadence pays, which says nothing is missing from the read itself. */
const YIELD_BASIS_COLUMN: HeadlessPaneColumn = { key: "yieldBasis", header: "Yield basis", format: (value) => typeof value === "string" ? value : "",
  description: "How many payments the trailing yield counts when a regular payer's year holds fewer than its cadence pays (a gap in its ex-dates)." };

/** `fn DVD A B C`: one table of every symbol, ranked by trailing yield. */
export function projectDividendRanking(entries: readonly DividendRankingEntry[], now = new Date()): HeadlessBundleResult {
  const rows = rankDividendEntries(entries, now);
  const bonds = entries.some(isBondEntry);
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
      title: `Ranked by trailing yield; payout is over TTM diluted EPS${bonds ? `; a bond fund's yields are distribution yields, ${NOT_SEC_YIELD}` : ""}`,
      columns: [...rankingColumns(bonds), ...incomplete.length > 0 ? [NOTE_COLUMN] : [], ...rows.some((row) => row.yieldBasis) ? [YIELD_BASIS_COLUMN] : []],
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
      payoutMethod: "Trailing twelve-month dividends over trailing twelve-month diluted EPS, as the source states it; N/M (not meaningful) when that EPS is zero or negative.",
      growthMethod: "Trailing twelve-month cash per share now against one and three years before; 3Y is a compound annual rate.",
      payDateMethod: "Pay date of the next declared distribution; past distributions carry ex-dates only.",
      ...bonds ? { secYieldMethod: `A bond fund's 30-day SEC yield as its sponsor publishes it, dated by secYieldAsOf, as a ratio like the other yields; its trailingYield and forwardYield are distribution yields, ${NOT_SEC_YIELD}.` } : {},
    },
  };
}
