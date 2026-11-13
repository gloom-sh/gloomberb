import type { HeadlessBundleResult, HeadlessPaneColumn } from "../../../types/headless";
import { MISSING_VALUE, formatPercent } from "../../../utils/format";
import { NOT_MEANINGFUL_TEXT } from "../../../utils/growth";
import type { DividendData } from "./client";
import { formatDividendYield, growthPaymentsDetail, PAYOUT_NOT_MEANINGFUL, trailingPaymentsText } from "./view";
import type { FundBondFacts } from "../../../api-client/fund-facts";
import { NOT_SEC_YIELD } from "../../../market-data/bond-funds";
import { historyEndsText } from "../../../utils/forward-dividend";
import {
  analyzeTaxEquivalent, distributionBasis, formatMuniTreasuryRatio, type NoBondFigures, type TaxEquivalentAnalysis, type TaxRates, type TreasuryTenor,
} from "../../../market-data/tax-equivalent";

/**
 * One symbol of `fn DVD A B C`: what DVD read for it, or why it read nothing.
 * A bond fund's facts give its SEC yield, which its cash yields are not; a
 * listing that has none says why (`noBondFigures`), and a check of them that
 * failed says so (`bondError`), which leaves a `--tax-rate` ranking partial.
 */
export type DividendRankingEntry =
  | { symbol: string; data: DividendData; bond?: FundBondFacts | null; noBondFigures?: NoBondFigures; bondError?: string }
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
  const { historyError, summaryError, forwardFromFundamentals, metrics } = entry.data;
  // A forward yield read from fundamentals in place of the summary is dated by the ex-date it annualizes.
  const forward = summaryError && forwardFromFundamentals && metrics.forwardRateAsOf
    ? `; fwd yield from fundamentals, ex ${metrics.forwardRateAsOf}` : "";
  if (historyError && summaryError) return `no cash history or summary${forward}`;
  if (historyError) return "no cash history";
  return summaryError ? `no summary${forward}` : null;
}

/**
 * How a row's trailing yield was counted, when its year holds fewer payments
 * than its cadence pays, or where a monthly payer's history ends; null
 * otherwise.
 */
function yieldBasis(entry: DividendRankingEntry): string | null {
  if (!("data" in entry)) return null;
  const lapse = entry.data.metrics.lapse;
  if (lapse?.historyEnds && lapse.lastPaid) return historyEndsText(lapse.lastPaid);
  const counted = trailingPaymentsText(entry.data.metrics.trailingPayments, { cadence: true });
  return counted ? `counts ${counted}` : null;
}

/** What a row is missing, in full, for the report's errors; null for a whole read. */
function incompleteReason(entry: DividendRankingEntry, tax = false): string | null {
  if ("error" in entry) return entry.error;
  // With --tax-rate a failed bond facts check leaves the row's tax figures unknown, as it does single-ticker DVD's.
  const reasons = [entry.data.historyError, entry.data.summaryError, tax ? entry.bondError : null].filter((reason): reason is string => !!reason);
  return reasons.length > 0 ? reasons.join(" ") : null;
}

/** Whether a ranked symbol is a bond fund, whose yields are then distribution yields beside its SEC yield. */
const isBondEntry = (entry: DividendRankingEntry) => "data" in entry && !!entry.bond;

/** A bond fund's SEC yield as a ratio, as the ranking's other yields are, with its own date; empty for any other row. */
function secYieldFields(entry: DividendRankingEntry): { secYield: number | null; secYieldAsOf: string | null } {
  const sec = "data" in entry ? entry.bond?.secYield : null;
  return { secYield: sec ? roundedRatio(sec.value / 100) : null, secYieldAsOf: sec?.asOf ?? null };
}

/** What `--tax-rate` reads a ranking with: the rates, and the Treasury curve its muni/Treasury ratios divide by. */
export interface RankingTaxOptions {
  rates: TaxRates;
  treasury: readonly TreasuryTenor[] | null;
}

/** A row's tax-equivalent yield and muni/Treasury ratio, on its SEC yield or else its distribution yield, as single-fund DVD reads them. */
function rankingTaxAnalysis(entry: DividendRankingEntry, tax: RankingTaxOptions): TaxEquivalentAnalysis | null {
  if (!("data" in entry)) return null;
  const metrics = entry.data.metrics;
  const forward = metrics.lapse ? null : distributionBasis(metrics.forwardYield, "forward", metrics.forwardRateAsOf ?? null);
  return analyzeTaxEquivalent({
    symbol: entry.symbol.toUpperCase(), bond: entry.bond ?? null, rates: tax.rates, treasury: tax.treasury,
    distribution: forward ?? distributionBasis(metrics.trailingYield, "trailing"),
    ...entry.bondError ? { checkError: entry.bondError } : {}, noBondFigures: entry.noBondFigures ?? null,
  });
}

/** Why a row has no tax-equivalent yield, or what it is on when not the SEC yield, in a few words. */
function taxNote(analysis: TaxEquivalentAnalysis | null, entry: DividendRankingEntry): string | null {
  if (!analysis || !("data" in entry)) return "error" in entry ? "not read" : null;
  if (entry.bondError) return "bond facts check failed";
  if (entry.noBondFigures) return entry.noBondFigures === "not-a-fund" ? "not a fund" : "fund listed outside the US";
  if (!entry.bond) return "no sponsor bond figures";
  if (entry.bond.kind !== "municipal") return "taxable fund";
  if (analysis.taxEquivalentYield == null) return "no yield";
  const notes = [analysis.basis?.kind === "distribution" ? "on distribution yield" : null, analysis.ratio ? null : "no duration for a ratio"];
  return notes.filter(Boolean).join("; ") || null;
}

/**
 * With `--tax-rate`: each row's yield to worst and duration as its sponsor
 * publishes them, its tax-equivalent yield and muni/Treasury ratio as ratios,
 * the Treasury tenor the ratio divides by, and why a row has none.
 */
function taxFields(entry: DividendRankingEntry, tax: RankingTaxOptions) {
  const bond = "data" in entry ? entry.bond : null;
  const analysis = rankingTaxAnalysis(entry, tax);
  return {
    yieldToWorst: bond?.yieldToWorst ? roundedRatio(bond.yieldToWorst.value / 100) : null,
    yieldToWorstAsOf: bond?.yieldToWorst?.asOf ?? null,
    duration: bond?.duration?.value ?? null,
    durationUnit: "years",
    durationAsOf: bond?.duration?.asOf ?? null,
    taxEquivalentYield: analysis?.taxEquivalentYield != null ? roundedRatio(analysis.taxEquivalentYield / 100) : null,
    muniTreasuryRatio: analysis?.ratio ? roundedRatio(analysis.ratio.value) : null,
    treasuryTenor: analysis?.ratio?.treasury.tenor ?? null,
    taxNote: taxNote(analysis, entry),
  };
}

/**
 * Rows ranked by trailing yield, highest first; a symbol without one, then
 * one that failed, last, in the order typed. Yield and growth are ratios, so
 * listings in different currencies rank together. With a bond fund among
 * them, each row carries the SEC yield after its forward yield.
 */
function rankDividendEntries(entries: readonly DividendRankingEntry[], now = new Date(), tax: RankingTaxOptions | null = null): Record<string, unknown>[] {
  const bonds = !!tax || entries.some(isBondEntry);
  const rows = entries.map((entry, index) => {
    if ("error" in entry) {
      return { index, failed: true, trailingYield: null, row: { symbol: entry.symbol, currency: null, price: null, priceAsOf: null, trailingYield: null, forwardYield: null,
        ...bonds ? secYieldFields(entry) : {}, ...tax ? taxFields(entry, tax) : {},
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
        ...bonds ? secYieldFields(entry) : {},
        ...tax ? taxFields(entry, tax) : {},
        payoutRatio: roundedRatio(metrics.payoutRatio),
        payoutNotMeaningful: metrics.payoutNotMeaningful === true,
        growth1Y: roundedRatio(metrics.growth1Y),
        growth3Y: roundedRatio(metrics.growth3Y),
        // Set when a year the figure compares is short of the cadence's payments: the figure is then n/a.
        ...metrics.growth1YPayments ? { growth1YPayments: growthPaymentsDetail(metrics.growth1YPayments) } : {},
        ...metrics.growth3YPayments ? { growth3YPayments: growthPaymentsDetail(metrics.growth3YPayments) } : {},
        // Set when the earlier year paid nothing and the later one paid: the figure is then N/M.
        ...metrics.growth1YNotMeaningful ? { growth1YNotMeaningful: true } : {},
        ...metrics.growth3YNotMeaningful ? { growth3YNotMeaningful: true } : {},
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
/**
 * A growth figure; n/m off a year that paid nothing (the row's `<key>NotMeaningful`; the text report draws N/M);
 * or n/a when one of its years is short (the row's `<key>Payments`).
 */
const growth = (key: "growth1Y" | "growth3Y", notMeaningful = NOT_MEANINGFUL_TEXT.toLowerCase()) => (value: unknown, row: Record<string, unknown>) =>
  typeof value !== "number" && row[`${key}NotMeaningful`] === true ? notMeaningful
    : typeof value !== "number" && typeof row[`${key}Payments`] === "string" ? "n/a" : formatPercent(typeof value === "number" ? value : undefined);
const day = (value: unknown) => typeof value === "string" && value ? value : MISSING_VALUE;

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
  { key: "growth1Y", header: "1Y growth", align: "right", format: growth("growth1Y"), textFormat: growth("growth1Y", NOT_MEANINGFUL_TEXT),
    description: "Trailing twelve-month cash per share against a year earlier; N/M when the year earlier paid nothing; n/a when either year holds fewer payments than the cadence pays." },
  { key: "growth3Y", header: "3Y CAGR", align: "right", format: growth("growth3Y"), textFormat: growth("growth3Y", NOT_MEANINGFUL_TEXT),
    description: "Compound annual growth of trailing twelve-month cash per share over three years; N/M when the year three years earlier paid nothing; n/a when either year holds fewer payments than the cadence pays." },
  { key: "lastExDate", header: "Last ex", format: day, shrink: false },
  { key: "payDate", header: "Next pay", format: day, shrink: false, stackPriority: 2,
    description: "Pay date of the next declared distribution; past distributions carry ex-dates only." },
];

/** Shown after the forward yield once a bond fund is ranked: its sponsor's SEC yield, and its date. */
const SEC_YIELD_COLUMNS: HeadlessPaneColumn[] = [
  { key: "secYield", header: "SEC yield", align: "right", format: ratio,
    description: "A bond fund's 30-day SEC yield as its sponsor publishes it; its Yield TTM and Fwd yield are distribution yields, not its SEC yield. Blank for any other listing." },
  { key: "secYieldAsOf", header: "SEC as of", format: day, shrink: false, stackPriority: 3,
    description: "The date the sponsor gives its SEC yield as of." },
];

const years = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(2)} yrs` : MISSING_VALUE;

/** Shown after the SEC yield with `--tax-rate`: the rest of a bond fund's sponsor figures, then what the tax rate makes of its yield. */
const TAX_COLUMNS: HeadlessPaneColumn[] = [
  { key: "yieldToWorst", header: "YTW", align: "right", format: ratio,
    description: "A bond fund's yield to worst as its sponsor publishes it (yieldToWorstAsOf dates it)." },
  { key: "duration", header: "Duration", align: "right", unitKey: "durationUnit", unitColumn: false, format: years, textFormat: years,
    description: "A bond fund's duration in years as its sponsor publishes it (durationAsOf dates it)." },
  { key: "taxEquivalentYield", header: "TEY", align: "right", format: ratio,
    description: "A muni fund's tax-equivalent yield at --tax-rate: its SEC yield (else its distribution yield) / (1 - the rate). Blank for a taxable fund." },
  // To one decimal, as single-ticker DVD and DES draw it.
  { key: "muniTreasuryRatio", header: "Muni/Tsy", align: "right",
    format: (value) => typeof value === "number" && Number.isFinite(value) ? formatMuniTreasuryRatio(value) : MISSING_VALUE,
    description: "A muni fund's yield over the Treasury par yield at the tenor nearest its duration (treasuryTenor)." },
  { key: "treasuryTenor", header: "Tenor", format: day, shrink: false, stackPriority: 4,
    description: "The Treasury tenor the muni/Treasury ratio divides by." },
];

/** Shown with `--tax-rate` once a row has no tax-equivalent yield, or one on its distribution yield. */
const TAX_NOTE_COLUMN: HeadlessPaneColumn = { key: "taxNote", header: "Tax note", format: (value) => typeof value === "string" ? value : "",
  description: "Why a row has no tax-equivalent yield (a taxable fund, not a fund, a fund listed outside the US, no sponsor bond figures, or a bond facts check that failed), or what it is on when not the SEC yield." };

/** The ranking's columns: a bond fund's SEC yield after the forward yield once one is ranked, and with `--tax-rate` its tax columns after it. */
function rankingColumns(bonds: boolean, tax = false): HeadlessPaneColumn[] {
  if (!bonds) return RANKING_COLUMNS;
  const after = RANKING_COLUMNS.findIndex((column) => column.key === "forwardYield") + 1;
  return [...RANKING_COLUMNS.slice(0, after), ...SEC_YIELD_COLUMNS, ...tax ? TAX_COLUMNS : [], ...RANKING_COLUMNS.slice(after)];
}

/** Shown once a row is incomplete, so a missing figure never reads as a non-payer's. */
const NOTE_COLUMN: HeadlessPaneColumn = { key: "note", header: "Note", format: (value) => typeof value === "string" ? value : "",
  description: "What the read of this ticker is missing: not read, no cash history (yields and growth), or no summary (forward yield, payout, pay date); a forward yield read from fundamentals instead is dated by its ex-date." };

/** Shown once a regular payer's trailing year holds fewer payments than its cadence pays, which says nothing is missing from the read itself. */
const YIELD_BASIS_COLUMN: HeadlessPaneColumn = { key: "yieldBasis", header: "Yield basis", format: (value) => typeof value === "string" ? value : "",
  description: "How many payments the trailing yield counts when a regular payer's year holds fewer than its cadence pays (a gap in its ex-dates)." };

/** `fn DVD A B C`: one table of every symbol, ranked by trailing yield; with `--tax-rate`, each fund's bond and tax columns. */
export function projectDividendRanking(entries: readonly DividendRankingEntry[], now = new Date(), tax: RankingTaxOptions | null = null): HeadlessBundleResult {
  const rows = rankDividendEntries(entries, now, tax);
  const bonds = !!tax || entries.some(isBondEntry);
  // A failed read, or one without its cash history or summary, is as incomplete as single-ticker DVD says it is.
  const incomplete = entries.flatMap((entry) => {
    const reason = incompleteReason(entry, !!tax);
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
      columns: [...rankingColumns(bonds, !!tax), ...rows.some((row) => row.note) ? [NOTE_COLUMN] : [], ...rows.some((row) => row.yieldBasis) ? [YIELD_BASIS_COLUMN] : [],
        ...tax && rows.some((row) => row.taxNote) ? [TAX_NOTE_COLUMN] : []],
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
      ...tax ? {
        taxRates: tax.rates,
        taxEquivalentMethod: "A muni fund's SEC yield (else its distribution yield) / (1 - (federal rate + the state rate for a single-state fund of --state)), as a ratio; blank for a taxable fund.",
        muniTreasuryRatioMethod: "A muni fund's yield over the Treasury par yield at the tenor nearest its sponsor's duration (treasuryTenor), from GC's curve.",
      } : {},
    },
  };
}
