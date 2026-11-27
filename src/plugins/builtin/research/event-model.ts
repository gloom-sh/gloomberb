import { splitShareTerms } from "../../../market-data/split-terms";
import { adjustedForText, adjustmentsAfter, demergerSuccessor, priceAdjustment, priceAdjustments, publishedDividend, publishedEps } from "../../../market-data/price-adjustments";
import type { CatalystEvent, CatalystFilters, CatalystResponse } from "../../../api-client/catalysts";
import { catalystDate } from "../catalysts/model";
import type {
  AnalystEstimateRecord,
  AnalystResearchData,
  CorporateActionsData,
  DemergerAction,
  DividendAction,
  EarningsDateStatus,
  FilingEpsDetails,
  FinancialStatement,
  TickerFinancials,
} from "../../../types/financials";
import {
  MISSING_VALUE,
  formatDistributionAmount,
  formatCompact,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "../../../utils/format";
import { formatFilingDate } from "../../../utils/datetime-format";
import { computeTTM } from "../ticker-detail/financials/aggregation";
import { listingOwnsRow } from "../../../utils/statement-scope";
import { classifyInstrumentType } from "../../../tickers/instrument-kind";
import { isIndianEtfListing } from "../../../market-data/fund-actions";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { declaredDividendCash, declaredDividends } from "../../../utils/declared-dividends";
import { fiscalPeriodText, fiscalQuarterInYear, fiscalQuarterText, fiscalYearText } from "../earnings/fiscal-quarter";
import { fiscalYearEndMonth } from "../../../utils/fiscal-period";
import { isReasonCode, readableStatus } from "../../../utils/reason-codes";
import { fundamentalsEpsCurrency, SERVED_TRAILING_EPS } from "../../../utils/fundamentals";
import { isNotMeaningful, NOT_MEANINGFUL, NOT_MEANINGFUL_TEXT, NOT_MEANINGFUL_TONE, type Rate } from "../../../utils/growth";
import {
  ACTUAL_PENDING,
  displayEarningsEpsBasis,
  earningsDateStatus,
  earningsDetail,
  earningsDetailParts,
  epsBasisName,
  reportedEpsComparison,
  inFiscalMonth,
  isProvisionalActual,
  quarterLabel,
  showsEpsBasis,
  unconfirmedAdjustedEps,
  type EpsBasisName,
} from "../shared/earnings-report";

export const CORPORATE_ACTION_COVERAGE = "A price-adjustment factor is named a spin-off only where the demerger is on record; any other factor in no share terms is shown as a factor. The history's dividends and EPS before one are shown as adjusted for it; what the company published is shown as published. Merger terms and security conversions are not covered.";

export type EventStatus = "Earnings" | "Q Est" | "FY Est" | "TTM" | "Dividend" | "Split" | "Spin-off" | "Factor";

export interface EventRow extends FilingEpsDetails {
  id: string;
  date: string;
  dateType?: "announcement" | "fiscal-period-end";
  status: EventStatus;
  /**
   * The fiscal quarter an earnings row reports (Sep 2026), "-" when no source names it; empty on a row it does not
   * apply to (a dividend, a split), as are its EPS and revenue.
   */
  period: string;
  /** When in the day an earnings report comes out, as the source says it ("Pre Market"). */
  reportTime?: string;
  detail: string;
  epsCurrency?: string;
  revenueCurrency?: string;
  /** Raw provider split-feed description; does not verify a legal share split. */
  providerDescription?: string;
  adjustmentFactor?: number;
  qEps?: number;
  qRevenue?: number;
  earningsState?: "pending" | "reported";
  epsActual?: number;
  epsEstimate?: number;
  epsDifference?: number;
  surprisePercent?: number;
  /** The surprise is N/M: the estimate was of a loss, or of nothing. */
  surpriseNotMeaningful?: true;
  /** A reported figure's basis, or an upcoming estimate's when it is adjusted; the same quarter is named the same way in ERN. The TTM row's EPS is GAAP. */
  epsBasis?: EpsBasisName;
  epsComparisonUnconfirmed?: true;
  /** The reported figure is the company's press release's, provisional until the calendar's replaces it. */
  epsProvisional?: true;
  /** Analysts behind `epsEstimate`, when known. */
  epsAnalysts?: number;
  dateStatus?: EarningsDateStatus;
  providerId?: string;
  fetchedAt?: string;
  /** Keep the supplied ranges and comparison inputs available in detail/export. */
  estimateInputs?: { eps?: AnalystEstimateRecord; revenue?: AnalystEstimateRecord };
  estimateGrowthMetric?: "eps" | "revenue";
  /** An estimate row's growth over the year-ago figure, as a fraction, of `estimateGrowthMetric`. */
  estimateGrowth?: number;
  /** The estimate's growth is N/M: its year-ago figure was a loss, or nothing. `estimateGrowth` is then absent. */
  estimateGrowthNotMeaningful?: true;
  fiscalPeriodEnd?: string;
  periodDateSource?: FinancialStatement["dateSource"];
  providerPeriodDate?: string;
  dateEvidence?: FinancialStatement["dateEvidence"];
  annualEps?: number;
  annualRevenue?: number;
  /** A dividend row's: declared and not yet paid, kept apart from the paid history. */
  declared?: true;
  /** A dividend row's: a one-off beside the regular payments (the issuer's own forms say so of a paid one). */
  special?: true;
  /** A dividend row's payable date, YYYY-MM-DD, where the source states one. */
  payDate?: string;
  /**
   * A paid dividend's or a report's: what the later price adjustments its figures are adjusted for are
   * ("adjusted for the VYLR spin-off of 2026-10-01 (6665:1000)"). Its value stays as the history states it.
   */
  adjustedFor?: string;
  /** A spin-off row's demerger on record, which its price-adjustment factor is for. */
  demerger?: DemergerAction;
  /** A paid dividend as its issuer's forms or a fund's sponsor published it, shown as that. */
  published?: true;
  value: string;
  tone: "positive" | "negative" | "muted" | "text";
}

interface EstimatePair {
  date: string;
  period: string;
  eps?: AnalystEstimateRecord;
  revenue?: AnalystEstimateRecord;
}

function formatPeriod(period: string): string {
  const label = period.replace(/_/g, " ");
  return label
    .replace(/\bcurrent\b/g, "cur")
    .replace(/\bquarter\b/g, "qtr")
    .replace(/\byear\b/g, "yr")
    || MISSING_VALUE;
}

function isFiscalEstimatePeriod(period: string): boolean {
  return /\byear\b|^current_year$|^next_year$|^next_5y$/i.test(period);
}

function sortedQuarterlyStatements(
  financials: Pick<TickerFinancials, "quarterlyStatements" | "statementScope"> | null,
): FinancialStatement[] {
  return (financials?.quarterlyStatements ?? [])
    .filter((statement) => statement.date && listingOwnsRow(financials?.statementScope, statement))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function statementForEarningsDate(
  quarterlyStatements: readonly FinancialStatement[],
  earning: CorporateActionsData["earnings"][number],
): FinancialStatement | undefined {
  // Announcement proximity cannot establish which quarter a result describes:
  // only a stated fiscal quarter can. Vendor period aliases are usable only
  // when the statement retains that identity.
  const matches = earning.fiscalPeriod
    ? quarterlyStatements.filter((statement) => inFiscalMonth(statement.date, earning.fiscalPeriod))
    : earning.dateType === "fiscal-period-end"
      ? quarterlyStatements.filter((statement) => statement.date === earning.date || statement.providerDate === earning.date)
      : [];
  return matches.length === 1 ? matches[0] : undefined;
}

function estimateKey(estimate: AnalystEstimateRecord): string {
  return `${estimate.date}|${estimate.period}`;
}

function hasEstimateValue(estimate: AnalystEstimateRecord | undefined): boolean {
  return estimate?.average != null
    || estimate?.low != null
    || estimate?.high != null
    || estimate?.yearAgo != null
    || estimate?.growth != null
    || estimate?.analysts != null;
}

function buildEstimatePairs(data: AnalystResearchData | null): EstimatePair[] {
  const pairs = new Map<string, EstimatePair>();
  const ensurePair = (estimate: AnalystEstimateRecord): EstimatePair => {
    const key = estimateKey(estimate);
    const existing = pairs.get(key);
    if (existing) return existing;
    const pair: EstimatePair = { date: estimate.date, period: estimate.period };
    pairs.set(key, pair);
    return pair;
  };

  for (const estimate of data?.earningsEstimates ?? []) {
    if (hasEstimateValue(estimate)) ensurePair(estimate).eps = estimate;
  }
  for (const estimate of data?.revenueEstimates ?? []) {
    if (hasEstimateValue(estimate)) ensurePair(estimate).revenue = estimate;
  }

  return [...pairs.values()];
}

function formatEstimateDetail(pair: EstimatePair, relative?: string): string {
  const analystCounts: string[] = [];
  if (pair.eps?.analysts != null) analystCounts.push(`${pair.eps.analysts} EPS`);
  if (pair.revenue?.analysts != null) analystCounts.push(`${pair.revenue.analysts} rev`);
  const counts = analystCounts.length ? `${analystCounts.join(" / ")} analysts` : "Consensus";
  return relative ? `${relative}, ${counts}` : counts;
}

/** An estimate period the fiscal calendar names: the current or next quarter or year. */
const NAMED_ESTIMATE_PERIOD = /^(?:cur|next) (?:qtr|yr)$/;

/**
 * An estimate's growth over its year-ago figure: the source's, except off a year-ago figure at or below zero, where
 * it is N/M whatever the source worked out (a loss of 0.40 to a profit of 0.10 is no +125%). Undefined where there is none.
 */
export function estimateRate(estimate: AnalystEstimateRecord | undefined): Rate | undefined {
  if (!estimate) return undefined;
  const yearAgo = estimate.yearAgo;
  if (typeof yearAgo === "number" && Number.isFinite(yearAgo) && yearAgo <= 0) {
    return typeof estimate.growth === "number" || typeof estimate.average === "number" ? NOT_MEANINGFUL : undefined;
  }
  return typeof estimate.growth === "number" && Number.isFinite(estimate.growth) ? estimate.growth : undefined;
}

/** The pair's growth, its EPS's where it has one, else its revenue's, and which. */
function estimatePairGrowth(pair: EstimatePair): { rate: Rate; metric: "eps" | "revenue" } | null {
  const eps = estimateRate(pair.eps);
  if (eps !== undefined) return { rate: eps, metric: "eps" };
  const revenue = estimateRate(pair.revenue);
  return revenue !== undefined ? { rate: revenue, metric: "revenue" } : null;
}

function estimateTone(growth: Rate | undefined): EventRow["tone"] {
  if (growth === undefined) return "muted";
  if (isNotMeaningful(growth)) return NOT_MEANINGFUL_TONE;
  return growth >= 0 ? "positive" : "negative";
}

function estimateValue(growth: Rate | undefined): string {
  if (isNotMeaningful(growth)) return NOT_MEANINGFUL_TEXT;
  return growth === undefined ? MISSING_VALUE : formatPercent(growth);
}

/**
 * What the TTM row reads: the statements for its four quarters and revenue, and the trailing EPS of the fundamentals,
 * the figure `ticker` prints as EPS (TTM) (the filed quarters' when they give one, see time-series/filed-trailing-eps).
 */
export type EventFinancials = Pick<TickerFinancials, "quarterlyStatements" | "financialCurrency" | "statementScope"> & {
  /** The years, whose last end names the fiscal quarters (`Q1 FY2027`) as GUIDE and ERN do. */
  annualStatements?: readonly Pick<FinancialStatement, "date" | "statementScope">[];
  fundamentals?: Pick<NonNullable<TickerFinancials["fundamentals"]>, "eps" | "epsCurrency" | "financialCurrency" | "marketCapCurrency" | "trailingEpsSource"> | null;
  /** The listing's currency, which says whether an unlabelled EPS can be in the statements' (fundamentalsCurrency), and its type. */
  quote?: Pick<NonNullable<TickerFinancials["quote"]>, "currency" | "instrumentType" | "exchangeName" | "listingExchangeName" | "name"> | null;
  quoteMetadata?: Pick<NonNullable<TickerFinancials["quoteMetadata"]>, "instrumentType"> | null;
};

/**
 * A fund (an ETF, a closed-end fund) reports no earnings: a feed's EPS rows, estimates and statements for one
 * are another company's or noise, so its events are its distributions and splits alone.
 */
export function isFundListing(financials: EventFinancials | null, actions?: CorporateActionsData | null): boolean {
  const quote = financials?.quote;
  return [quote?.instrumentType, financials?.quoteMetadata?.instrumentType].some((type) => classifyInstrumentType(type) === "fund")
    || isIndianEtfListing(quote?.listingExchangeName || quote?.exchangeName, quote?.name)
    || (!!actions && (isIndianEtfListing(actions.exchange || parsePublicTickerKey(actions.symbol).exchange, actions.name)
      || /\bETF(?: Trust)?$/i.test(actions.name?.trim() ?? "")));
}

/**
 * The four reported rows behind the latest four statement quarters, summed, only when every one is on the adjusted
 * basis and in one currency. Quarters of different or unknown bases never add up to anything.
 */
function adjustedQuarterSum(
  latestFour: readonly FinancialStatement[],
  earnings: CorporateActionsData["earnings"],
): number | null {
  if (latestFour.length < 4) return null;
  const reported = earnings.filter((earning) => earning.epsActual != null);
  const quarters = latestFour.map((statement) => {
    const matches = reported.filter((earning) => statementForEarningsDate([statement], earning) === statement);
    return matches.length === 1 ? matches[0]! : null;
  });
  if (quarters.some((earning) => earning == null || displayEarningsEpsBasis(earning) !== "adjusted")) return null;
  if (new Set(quarters.map((earning) => earning!.currency)).size !== 1) return null;
  return quarters.reduce((sum, earning) => sum + earning!.epsActual!, 0);
}

/**
 * The TTM row's EPS is the GAAP diluted trailing figure `ticker` prints as EPS (TTM): the last four filed quarters',
 * or Gloom Cloud's trailing figure, named so, when they give none. Without either, the four statement quarters'
 * diluted EPS summed. The reported rows above it are often adjusted, so they are never added to it: only when all
 * four are adjusted does the detail also give their sum.
 */
function ttmRow(
  quarterlyStatements: readonly FinancialStatement[],
  earnings: CorporateActionsData["earnings"],
  financials: EventFinancials | null,
): EventRow | null {
  const latestFour = quarterlyStatements.slice(-4);
  const ttm = computeTTM([...quarterlyStatements]);
  if (!ttm || (ttm.totalRevenue == null && ttm.eps == null)) return null;
  const latest = latestFour.at(-1);
  const trailingEps = financials?.fundamentals?.eps;
  const served = typeof trailingEps === "number" && Number.isFinite(trailingEps);
  const eps = served ? trailingEps : financials?.statementScope ? undefined : ttm.eps;
  const adjusted = eps == null ? null : adjustedQuarterSum(latestFour, earnings);
  return {
    id: `ttm:${latest?.date ?? ""}`,
    date: latest?.date ?? "",
    status: "TTM",
    period: "4 qtrs",
    detail: [eps == null ? "statement sum" : !served ? "GAAP diluted (statements)"
      : financials?.fundamentals?.trailingEpsSource === "served" ? `GAAP diluted (${SERVED_TRAILING_EPS})` : "GAAP diluted",
      adjusted == null ? null : `adj sum ${formatNumber(adjusted, 2)}`].filter(Boolean).join(", "),
    epsCurrency: served ? fundamentalsEpsCurrency(financials) : ttm.currency ?? financials?.financialCurrency,
    revenueCurrency: ttm.currency ?? financials?.financialCurrency,
    epsBasis: eps == null ? undefined : "GAAP",
    annualEps: eps,
    annualRevenue: ttm.totalRevenue,
    value: MISSING_VALUE,
    tone: "muted",
  };
}

function earningsRowIds(earnings: CorporateActionsData["earnings"]): string[] {
  const baseIds = earnings.map((earning) => `earn:${earning.date}${earning.dateType ? `:${earning.dateType}` : ""}`);
  const counts = new Map<string, number>();
  for (const id of baseIds) counts.set(id, (counts.get(id) ?? 0) + 1);
  const occurrences = new Map<string, number>();
  return earnings.map((earning, index) => {
    let id = baseIds[index]!;
    // The source has no event ID or fiscal-period identity for announcements.
    // Retain colliding records without assigning inferred periods; their supplied
    // inputs keep distinct details stable when the provider reorders the feed.
    if (counts.get(id)! > 1) id += `:${JSON.stringify([
      earning.time ?? null, earning.currency ?? null, earning.epsActual ?? null,
      earning.epsEstimate ?? null, earning.difference ?? null, earning.surprisePercent ?? null,
    ])}`;
    const occurrence = (occurrences.get(id) ?? 0) + 1;
    occurrences.set(id, occurrence);
    return occurrence === 1 ? id : `${id}:${occurrence}`;
  });
}

/** Quarter ends closer than this are the same fiscal quarter under different normalizations. */
const SAME_QUARTER_MS = 45 * 86_400_000;

function reportedPeriodTimes(
  earnings: CorporateActionsData["earnings"],
  quarterlyStatements: readonly FinancialStatement[],
): number[] {
  return earnings
    .filter((earning) => earning.epsActual != null && (earning.dateType === "fiscal-period-end" || earning.fiscalPeriod))
    .flatMap((earning) => [
      earning.fiscalPeriod ? fiscalMonthEnd(earning.fiscalPeriod) : earning.date,
      statementForEarningsDate(quarterlyStatements, earning)?.date,
    ])
    .map((date) => Date.parse(date ?? ""))
    .filter(Number.isFinite);
}

/** The last day of a YYYY-MM fiscal quarter end month. */
function fiscalMonthEnd(period: string): string | undefined {
  const match = /^(\d{4})-(\d{2})$/.exec(period);
  return match ? new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).toISOString().slice(0, 10) : undefined;
}

/**
 * An upstream snapshot can keep serving a reported quarter as "0q" until its trend rolls
 * (REF and ORCL in Sep 2026), so that consensus describes a past period.
 */
function isReportedQuarter(periodEnd: string, reportedPeriodEnds: readonly number[]): boolean {
  const time = Date.parse(periodEnd);
  return Number.isFinite(time) && reportedPeriodEnds.some((reported) => Math.abs(time - reported) < SAME_QUARTER_MS);
}

function eventSortRank(status: EventStatus): number {
  switch (status) {
    case "Q Est": return 0;
    case "FY Est": return 1;
    case "Earnings": return 2;
    case "TTM": return 3;
    case "Dividend": return 4;
    case "Split":
    case "Spin-off":
    case "Factor": return 5;
  }
}

/**
 * An earnings row's detail; a report not out yet also says when in the day it
 * comes, after whether its date is confirmed: `confirmed, After Hours, 17
 * analysts`. The time is never the row's period.
 */
function upcomingEarningsDetail(earning: CorporateActionsData["earnings"][number]): string {
  const time = earning.time?.trim();
  if (earning.epsActual != null || !time) return earningsDetail(earning);
  const parts = earningsDetailParts(earning);
  if (parts.length === 0) return `Pending, ${time}`;
  // The time follows whether the date is announced, or that the report is out with its actual pending.
  const at = earningsDateStatus(parts[0]) || parts[0] === ACTUAL_PENDING ? 1 : 0;
  return [...parts.slice(0, at), time, ...parts.slice(at)].join(", ");
}

/** "special" when every dividend the issuer's forms say a paid row holds is one, "incl. special" when some are. */
function dividendSpecial(dividend: DividendAction): "special" | "incl. special" | null {
  const parts = dividend.parts ?? [];
  if (!parts.some((part) => part.special)) return null;
  return parts.every((part) => part.special) ? "special" : "incl. special";
}

export function buildEventRows(
  data: CorporateActionsData | null,
  estimates: AnalystResearchData | null,
  financials: EventFinancials | null,
  currency: string,
): EventRow[] {
  const rows: EventRow[] = [];
  const fund = isFundListing(financials, data);
  const quarterlyStatements = fund ? [] : sortedQuarterlyStatements(financials);
  const earnings = fund ? [] : data?.earnings ?? [];
  const ttm = ttmRow(quarterlyStatements, earnings, financials);
  if (ttm) rows.push(ttm);

  const earningsIds = earningsRowIds(earnings);
  // Quarters and years by the names GUIDE and ERN give them (Q1 FY2027), where the company's years say when they end.
  const yearEnd = fiscalYearEndMonth(financials?.annualStatements?.filter(row => listingOwnsRow(financials.statementScope, row)) ?? []);
  // An upcoming report often arrives without a currency; the feed's reported
  // quarters give it when they all agree on one.
  const feedCurrencies = new Set(earnings.map((earning) => earning.currency).filter(Boolean));
  const feedCurrency = feedCurrencies.size === 1 ? [...feedCurrencies][0] : undefined;
  // So do the oldest reported quarters (before 2024), which the feed leaves unlabelled, but only where the
  // company's own EPS is in that currency too: one company's EPS then reads in one unit down the table, and an
  // unlabelled figure nothing else vouches for stays unlabelled.
  const listingCurrency = !financials?.statementScope || financials.statementScope.basis === "standalone" ? fundamentalsEpsCurrency(financials) : undefined;
  const reportedCurrency = feedCurrency && listingCurrency === feedCurrency ? feedCurrency : undefined;
  // The history's EPS before a price adjustment is adjusted for it (CTVA's before the VYLR spin-off of 2026-10-01): said
  // on the row. A release's own EPS is as the company reported it, whatever its date.
  const adjustments = priceAdjustments(data?.splits, data?.demergers);
  for (const [index, earning] of earnings.entries()) {
    // A pending announcement must never inherit the previous report's actuals.
    const statement = earning.epsActual == null ? undefined : statementForEarningsDate(quarterlyStatements, earning);
    const basis = displayEarningsEpsBasis(earning);
    const comparison = reportedEpsComparison(earning);
    const surprise = comparison?.surprise;
    // Against a loss or zero estimate no percentage is shown, the source's either.
    const surpriseNotMeaningful = earning.epsActual != null && isNotMeaningful(surprise);
    const surprisePercent = typeof surprise === "number" ? Math.round(surprise * 10_000) / 100 : undefined;
    const adjustedEps = (earning.epsActual == null && earning.epsEstimate == null) || publishedEps(earning) ? [] : adjustmentsAfter(adjustments, earning.date);
    rows.push({
      id: earningsIds[index]!,
      // An announcement keeps its date beside ERN's; a period-end row moves to its statement's.
      date: earning.dateType === "fiscal-period-end" ? statement?.date ?? earning.date : earning.date,
      dateType: earning.dateType,
      status: "Earnings",
      // The fiscal quarter, never the time of day ("After Hours"), which the row keeps as reportTime.
      period: fiscalPeriodText(earning.fiscalPeriod ?? statement?.date, fiscalQuarterInYear(earning.fiscalPeriod ?? statement?.date, yearEnd)),
      ...(earning.time?.trim() ? { reportTime: earning.time.trim() } : {}),
      detail: [upcomingEarningsDetail(earning), adjustedEps.length ? `EPS ${adjustedForText(adjustedEps, false)}` : ""].filter(Boolean).join(", "),
      ...(adjustedEps.length ? { adjustedFor: `EPS ${adjustedForText(adjustedEps)}` } : {}),
      epsCurrency: earning.currency ?? (earning.epsActual == null ? feedCurrency : unconfirmedAdjustedEps(earning) ? undefined : reportedCurrency),
      revenueCurrency: statement ? statement.currency ?? financials?.financialCurrency : undefined,
      qEps: earning.epsActual ?? earning.epsEstimate,
      ...(earning.streetEps ? { streetEps: earning.streetEps, gaapEps: earning.gaapEps } : {}),
      qRevenue: statement?.totalRevenue,
      earningsState: earning.epsActual == null ? "pending" : "reported",
      epsActual: earning.epsActual,
      epsEstimate: earning.epsEstimate,
      epsDifference: comparison?.difference,
      surprisePercent,
      ...(surpriseNotMeaningful ? { surpriseNotMeaningful: true as const } : {}),
      epsBasis: showsEpsBasis({ epsActual: earning.epsActual, epsBasis: basis }) ? epsBasisName(basis) : undefined,
      ...(unconfirmedAdjustedEps(earning) ? { epsComparisonUnconfirmed: true as const } : {}),
      ...(isProvisionalActual(earning) ? { epsProvisional: true as const } : {}),
      epsAnalysts: earning.epsAnalysts,
      dateStatus: earningsDateStatus(earning.dateStatus) ?? undefined,
      providerId: data?.providerId,
      fetchedAt: data?.fetchedAt,
      fiscalPeriodEnd: statement?.date,
      periodDateSource: statement?.dateSource,
      providerPeriodDate: earning.dateType === "fiscal-period-end" ? earning.date : undefined,
      dateEvidence: statement?.dateEvidence,
      value: surpriseNotMeaningful ? NOT_MEANINGFUL_TEXT : surprisePercent != null ? formatPercentRaw(surprisePercent) : MISSING_VALUE,
      // N/M in the tone every pane draws N/M in: no colour of a beat or a miss for a percentage that says nothing.
      tone: surpriseNotMeaningful ? NOT_MEANINGFUL_TONE
        : surprisePercent == null ? "muted" : surprisePercent >= 0 ? "positive" : "negative",
    });
  }

  const reportedPeriodEnds = reportedPeriodTimes(earnings, quarterlyStatements);
  for (const pair of fund ? [] : buildEstimatePairs(estimates)) {
    const isFiscal = isFiscalEstimatePeriod(pair.period);
    if (!isFiscal && isReportedQuarter(pair.date, reportedPeriodEnds)) continue;
    const growth = estimatePairGrowth(pair);
    const relative = formatPeriod(pair.period);
    const named = !NAMED_ESTIMATE_PERIOD.test(relative) ? null
      : isFiscal ? fiscalYearText(pair.date, yearEnd) : fiscalQuarterText(fiscalQuarterInYear(pair.date, yearEnd));
    rows.push({
      id: `estimate:${pair.date}:${pair.period}`,
      date: pair.date,
      status: isFiscal ? "FY Est" : "Q Est",
      // Named as the company's fiscal calendar names it; which one it is from today ("cur qtr") leads the detail.
      period: named ?? relative,
      detail: formatEstimateDetail(pair, named ? relative : undefined),
      providerId: estimates?.providerId,
      fetchedAt: estimates?.fetchedAt,
      estimateInputs: {
        ...(pair.eps ? { eps: { ...pair.eps } } : {}),
        ...(pair.revenue ? { revenue: { ...pair.revenue } } : {}),
      },
      estimateGrowthMetric: growth?.metric,
      ...typeof growth?.rate === "number" ? { estimateGrowth: growth.rate } : {},
      ...isNotMeaningful(growth?.rate) ? { estimateGrowthNotMeaningful: true as const } : {},
      epsCurrency: pair.eps?.currency,
      revenueCurrency: pair.revenue?.currency,
      qEps: isFiscal ? undefined : pair.eps?.average,
      qRevenue: isFiscal ? undefined : pair.revenue?.average,
      annualEps: isFiscal ? pair.eps?.average : undefined,
      annualRevenue: isFiscal ? pair.revenue?.average : undefined,
      value: estimateValue(growth?.rate),
      tone: estimateTone(growth?.rate),
    });
  }

  const dividendCurrency = data?.currency ?? currency;
  // The paid history is stated on today's shares: an amount before a split or bonus issue on record is that split's.
  const splitDates = (data?.splits ?? []).filter((split) => splitShareTerms(split)).map((split) => split.date);
  for (const dividend of data?.dividends ?? []) {
    const special = dividendSpecial(dividend);
    // A row the issuer's forms or a fund's sponsor published stands as published: its date before a split or an
    // adjustment says nothing of its basis. The history's own rows before one are adjusted for it, and say so.
    const published = publishedDividend(dividend);
    const adjusted = !published && splitDates.some((date) => date > dividend.exDate);
    const adjustedBy = published ? [] : adjustmentsAfter(adjustments, dividend.exDate);
    rows.push({
      id: `div:${dividend.exDate}`,
      date: dividend.exDate,
      status: "Dividend",
      period: "",
      // Only what the row does not say already: its date is the ex-date.
      detail: [special, dividend.payDate ? `payable ${dividend.payDate}` : null, adjusted ? "split-adjusted" : null,
        adjustedBy.length ? adjustedForText(adjustedBy, false) : null,
      ].filter(Boolean).join(", "),
      ...(special === "special" ? { special: true as const } : {}),
      ...(dividend.payDate ? { payDate: dividend.payDate } : {}),
      ...(adjustedBy.length ? { adjustedFor: adjustedForText(adjustedBy) } : {}),
      ...(published ? { published: true as const } : {}),
      value: formatDistributionAmount(dividend.amount, dividendCurrency),
      // An amount is no gain or loss: it takes no tone.
      tone: "text",
    });
  }

  // Declared and unpaid: its own row at its ex-date, apart from the paid distributions above.
  for (const dividend of declaredDividends(data)) {
    const cash = declaredDividendCash(dividend, dividendCurrency);
    rows.push({
      id: `div-declared:${dividend.exDate}`,
      date: dividend.exDate,
      status: "Dividend",
      period: "",
      // A one-off beside the regular payments says so: "Declared special, payable 2026-11-25".
      detail: `Declared${dividend.special ? " special" : ""}${cash.estimate ? `, ${cash.estimate}` : ""}${dividend.payDate ? `, payable ${dividend.payDate}` : ""}`,
      declared: true,
      ...(dividend.special ? { special: true as const } : {}),
      ...(dividend.payDate ? { payDate: dividend.payDate } : {}),
      value: cash.amount,
      tone: "text",
    });
  }

  for (const split of data?.splits ?? []) {
    // A factor of whole share counts is a split, said in its terms (DBS's bonus issue: 11-for-10, 1 new share for
    // every 10 held), whatever its date. One in no share terms on a demerger's ex-date is that spin-off's price
    // adjustment (CTVA's 6665:1000, VYLR's), one row for both; any other says no more than that it is a factor.
    const demerger = priceAdjustment(split, data?.demergers)?.demerger;
    const terms = splitShareTerms(split);
    rows.push({
      id: `split:${split.date}:${split.description ?? ""}`,
      date: split.date,
      status: demerger ? "Spin-off" : terms ? "Split" : "Factor",
      period: "",
      detail: demerger ? spinOffDetail(demerger) : terms ?? "Split/adjustment",
      ...(demerger ? { demerger } : {}),
      providerDescription: split.description,
      adjustmentFactor: split.fromFactor && split.toFactor ? split.toFactor / split.fromFactor : split.ratio,
      value: split.fromFactor && split.toFactor
        ? `${split.toFactor}:${split.fromFactor}`
        : formatNumber(split.ratio, 4),
      tone: "muted",
    });
  }

  return rows.sort((left, right) => (
    right.date.localeCompare(left.date)
    || eventSortRank(left.status) - eventSortRank(right.status)
    || left.period.localeCompare(right.period)
  ));
}

/** One figure of the summary over the events table, in the shape the kit's StatGrid takes. */
export interface EventSummaryFigure {
  id: "next-report" | "next-ex" | "last-ex" | "eps-estimate" | "revenue-estimate" | "next-catalyst" | "ttm-eps" | "ttm-revenue";
  label: string;
  value: string;
  detail?: string;
  /** Shorter forms of `detail`, longest first. */
  detailVariants?: string[];
  tone?: "positive" | "negative" | "muted";
}

/** A quarter as the company's fiscal calendar names it: `Q1 FY2027`. */
const NAMED_FISCAL_QUARTER = /^Q[1-4] FY\d{4}$/;

/** The quarter a report covers ends before it, within this many days. */
const REPORT_LAG_DAYS = 120;

function daysFrom(from: string, to: string): number {
  return (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
}

/** Distinct forms of a detail, longest first, each a ` · ` join of its parts. */
function detailForms(...forms: Array<Array<string | null | undefined>>): { detail?: string; detailVariants?: string[] } {
  const joined = [...new Set(forms.map((parts) => parts.filter(Boolean).join(" · ")).filter(Boolean))];
  if (!joined.length) return {};
  return { detail: joined[0], ...(joined.length > 1 ? { detailVariants: joined.slice(1) } : {}) };
}

/**
 * The next report on the calendar and the quarter it covers: the last
 * quarter analysts estimate that ends before it, within a report's lag.
 * Without a dated report, the earliest quarter analysts still estimate.
 */
export function nextReportOf(rows: readonly EventRow[], today: string): { report?: EventRow; quarter?: EventRow } {
  const report = rows
    .filter((row) => row.status === "Earnings" && row.earningsState === "pending" && row.dateType !== "fiscal-period-end" && row.date >= today)
    .sort((left, right) => left.date.localeCompare(right.date))[0];
  const quarters = rows.filter((row) => row.status === "Q Est").sort((left, right) => left.date.localeCompare(right.date));
  const quarter = report
    ? quarters.filter((row) => row.date <= report.date && daysFrom(row.date, report.date) <= REPORT_LAG_DAYS).at(-1)
    : quarters[0];
  return { ...(report ? { report } : {}), ...(quarter ? { quarter } : {}) };
}

/** A quarter as the fiscal calendar names it, else by the month it ends in: never by its place from today. */
export function quarterName(row: EventRow): string {
  return NAMED_FISCAL_QUARTER.test(row.period) ? row.period : `${quarterLabel(row.date)} qtr`;
}

/** How far ahead a day is, in words: `today`, `tomorrow`, `in 12 days`. */
function daysAhead(today: string, day: string): string {
  const days = Math.round(daysFrom(today, day));
  return days <= 0 ? "today" : days === 1 ? "tomorrow" : `in ${days} days`;
}

/** A catalyst the opening block names: its day (or month or year, as dated) and title. */
export interface NextCatalyst {
  date: string;
  label: string;
}

/** How the Events views and `fn EVT` ask the catalyst calendar for a company's next catalysts. */
export function nextCatalystQuery(symbol: string): CatalystFilters {
  return { symbol, upcoming: true, dateField: "any", limit: 20, offset: 0 };
}

/**
 * Where a catalyst's date falls in the calendar's own order, which the service
 * sorts its upcoming rows by: a date known only to its month or year at the
 * end of it, so `Dec 2026` comes after `25 Dec 2026`.
 */
function catalystOrderKey(date: string): string {
  return date.length === 4 ? `${date}-12-31` : date.length === 7 ? `${date}-31` : date;
}

/**
 * The earliest catalyst dated today or later among a company's upcoming ones,
 * read as the Catalysts view lists them. One dated to its month or year only
 * counts while that month or year is not over; one whose date is withheld
 * does not count.
 *
 * A free preview holds rows back (`access.lockedUpcoming`). The service sends
 * a calendar's rows earliest first and the preview is the head of that order
 * (checked live, 2026-11-25: the free rows were Pro's first rows for every
 * ticker read), so the held-back rows all come later and the first shown is
 * the next. Should the shown rows ever come in another order, a held-back row
 * may be the next one: then none is named, rather than a later one as next.
 */
export function nextCatalystOf(
  payload: { events: readonly CatalystEvent[]; access?: CatalystResponse["access"] },
  today: string,
): NextCatalyst | null {
  const read = { upcoming: true, dateField: "any" as const };
  const ahead = payload.events
    .map((event) => ({ event, date: catalystDate(event, read) }))
    .filter(({ date }) => /^\d{4}(-\d{2}){0,2}$/.test(date) && date >= today.slice(0, date.length))
    .map((entry) => ({ ...entry, key: catalystOrderKey(entry.date) }));
  const access = payload.access;
  const held = access?.pro === false ? access.lockedUpcoming ?? access.lockedRows : 0;
  if (held > 0 && ahead.some((entry, index) => index > 0 && entry.key < ahead[index - 1]!.key)) return null;
  const next = ahead.sort((left, right) => left.key.localeCompare(right.key))[0];
  return next ? { date: next.date, label: next.event.title } : null;
}

export interface NextUpOptions {
  /** The listing's own day, YYYY-MM-DD: a report or ex-date from it on is ahead. */
  today: string;
  fund: boolean;
  /** The ex-date the listing's figures state (fundamentals' exDividendDate), which can be the next one before its amount is declared. */
  statedExDate?: string;
  /** The company's next dated catalyst (a regulatory decision, a court date), when one is on record. */
  catalyst?: NextCatalyst | null;
}

/** An estimate's growth on the year before as the figures say it: N/M off a year-ago loss or zero, as the tables draw it. */
function yearOnYear(estimate: AnalystEstimateRecord | undefined): string | null {
  const rate = estimateRate(estimate);
  if (isNotMeaningful(rate)) return `${NOT_MEANINGFUL_TEXT} y/y`;
  return rate == null ? null : `${formatPercentRaw(rate * 100)} y/y`;
}

/**
 * The Events tab's opening block: what is next, each with how far away it is.
 * The next report with calendar EPS (or quarter EPS if absent), quarter revenue,
 * the next ex-date with its amount (the last one while none is known), and the
 * next catalyst. A fund has its ex-dates only.
 */
export function buildNextUp(rows: readonly EventRow[], options: NextUpOptions): EventSummaryFigure[] {
  const { today } = options;
  const figures: EventSummaryFigure[] = [];
  const date = (day: string) => formatFilingDate(day, day);
  if (!options.fund) {
    const { report, quarter } = nextReportOf(rows, today);
    const period = report && report.period !== MISSING_VALUE ? report.period : quarter ? quarterName(quarter) : undefined;
    if (report) {
      const status = report.dateStatus === "projected" ? "projected" : report.dateStatus === "confirmed" ? "confirmed" : null;
      figures.push({ id: "next-report", label: "Next report", value: date(report.date),
        ...detailForms([daysAhead(today, report.date), status, period], [daysAhead(today, report.date), status], [daysAhead(today, report.date)]) });
    } else if (quarter) {
      figures.push({ id: "next-report", label: "Next report", value: quarterName(quarter), detail: "not dated yet" });
    }
    const quarterEps = quarter?.estimateInputs?.eps;
    const { amount, currency, analysts, growth } = report?.epsEstimate != null
      ? { amount: report.epsEstimate, currency: report.epsCurrency, analysts: report.epsAnalysts, growth: null }
      : { amount: quarter?.qEps, currency: quarter?.epsCurrency, analysts: quarterEps?.analysts, growth: yearOnYear(quarterEps) };
    if (amount != null) {
      figures.push({ id: "eps-estimate", label: "EPS est", value: formatEventMetric(amount, currency, "eps"),
        ...detailForms([analysts ? `${analysts} ${analysts === 1 ? "analyst" : "analysts"}` : null, growth], [growth]) });
    }
    if (quarter?.qRevenue != null) {
      const analysts = quarter.estimateInputs?.revenue?.analysts;
      const growth = yearOnYear(quarter.estimateInputs?.revenue);
      figures.push({ id: "revenue-estimate", label: "Revenue est", value: formatEventMetric(quarter.qRevenue, quarter.revenueCurrency, "revenue"),
        ...detailForms([analysts ? `${analysts} ${analysts === 1 ? "analyst" : "analysts"}` : null, growth], [growth]) });
    }
  }
  const dividends = rows.filter((row) => row.status === "Dividend");
  const declared = dividends.filter((row) => row.declared && row.date >= today).sort((left, right) => left.date.localeCompare(right.date))[0];
  const latestPaid = dividends.filter((row) => !row.declared).sort((left, right) => right.date.localeCompare(left.date))[0];
  const stated = options.statedExDate && /^\d{4}-\d{2}-\d{2}$/.test(options.statedExDate) ? options.statedExDate : undefined;
  if (declared) {
    figures.push({ id: "next-ex", label: "Next ex", value: date(declared.date),
      ...detailForms([declared.value, declared.special ? "special" : null, daysAhead(today, declared.date)], [declared.value, daysAhead(today, declared.date)], [declared.value]) });
  } else if (stated && stated >= today && (!latestPaid || stated > latestPaid.date)) {
    figures.push({ id: "next-ex", label: "Next ex", value: date(stated),
      ...detailForms([daysAhead(today, stated), latestPaid ? `last paid ${paidValue(latestPaid)}` : null], [daysAhead(today, stated)]) });
  } else if (latestPaid) {
    figures.push({ id: "last-ex", label: "Last ex", value: date(latestPaid.date), detail: paidValue(latestPaid) });
  }
  if (options.catalyst && !options.fund) {
    // A source can date a catalyst to its month or year only (a trial's completion): it is said that way.
    const day = options.catalyst.date;
    const exact = day.length === 10;
    figures.push({ id: "next-catalyst", label: "Next catalyst", value: exact ? date(day) : day.length === 7 ? quarterLabel(`${day}-01`) : day,
      ...detailForms([exact ? daysAhead(today, day) : null, options.catalyst.label], [options.catalyst.label]) });
  }
  return figures;
}

/** The forward estimates as EE's Estimates view lists them: the quarters, then the years, each nearest first. */
export function forwardEstimates(rows: readonly EventRow[]): { quarters: EventRow[]; years: EventRow[] } {
  const byDate = (left: EventRow, right: EventRow) => left.date.localeCompare(right.date);
  return {
    quarters: rows.filter((row) => row.status === "Q Est").sort(byDate),
    years: rows.filter((row) => row.status === "FY Est").sort(byDate),
  };
}

/** A paid row's amount, said to be adjusted where a later price adjustment changed it: "$0.027007 (adjusted)". */
function paidValue(row: EventRow): string {
  return row.adjustedFor ? `${row.value} (adjusted)` : row.value;
}

/** A spin-off row's detail: "Seed business into VYLR:NYSE (Vylor Inc.), 1 share per share". */
function spinOffDetail(demerger: DemergerAction): string {
  const what = demerger.business ? `${demerger.business.charAt(0).toUpperCase()}${demerger.business.slice(1)} business into` : "Into";
  return [`${what} ${demergerSuccessor(demerger)}`, demerger.ratio ? `${demerger.ratio} share per share` : null].filter(Boolean).join(", ");
}

/** Statuses that are corporate actions, not earnings: EE's header leaves them out. */
const CORPORATE_ACTIONS: ReadonlySet<EventStatus> = new Set(["Dividend", "Split", "Spin-off", "Factor"]);

/**
 * EE's header, over both its views: what is next (the report and the
 * consensus EPS and revenue for the quarter it covers) and the trailing twelve
 * months, EPS and revenue. The trailing EPS is the GAAP diluted figure
 * `ticker` prints (the TTM row's), named so. No ex-dates or catalysts, which
 * are EVT's. A fund has none of it.
 */
export function buildEarningsHeader(rows: readonly EventRow[], options: { today: string; fund: boolean }): EventSummaryFigure[] {
  if (options.fund) return [];
  const figures = buildNextUp(rows.filter((row) => !CORPORATE_ACTIONS.has(row.status)), { today: options.today, fund: false });
  const ttm = rows.find((row) => row.status === "TTM");
  if (!ttm) return figures;
  const through = ttm.date ? `4 qtrs to ${formatFilingDate(ttm.date, ttm.date)}` : "4 qtrs";
  if (ttm.annualEps != null) {
    figures.push({ id: "ttm-eps", label: "EPS TTM", value: formatEventMetric(ttm.annualEps, ttm.epsCurrency, "eps"),
      ...detailForms([ttm.detail, through], [ttm.detail]) });
  }
  if (ttm.annualRevenue != null) {
    figures.push({ id: "ttm-revenue", label: "Revenue TTM", value: formatEventMetric(ttm.annualRevenue, ttm.revenueCurrency, "revenue"), detail: through });
  }
  return figures;
}

export interface EventSourceState {
  variant: "corporate-actions" | "earnings-estimates";
  symbol: string;
  actions: CorporateActionsData | null;
  actionsError: string | null;
  estimates: AnalystResearchData | null;
  estimatesError: string | null;
}

export interface EventSourceNotice {
  text: string;
  /** True when a source failed, as opposed to a source that had nothing. */
  failed: boolean;
}

/**
 * The table can still show a TTM line built from statements while both event
 * sources returned nothing, which used to read as a working pane that happens
 * to be almost empty. This says which source is missing so a thin pane
 * explains itself instead of looking broken.
 */
export function eventSourceNotice(state: EventSourceState): EventSourceNotice | null {
  const actionsLabel = state.variant === "earnings-estimates"
    ? "Reported earnings"
    : "Corporate actions";
  const notices: string[] = [];
  const unavailableSections = Object.entries(state.actions?.coverage ?? {})
    .filter(([section, status]) => status === "unavailable" && (state.variant !== "earnings-estimates" || section === "earnings"))
    .map(([section]) => section);
  // Sections and estimates that a source failed to give share one line: "Unavailable: earnings, analyst estimates (the source did not answer)".
  const estimatesCode = isReasonCode(state.estimatesError);
  const sharedLine = !state.actionsError && unavailableSections.length > 0 && estimatesCode;

  if (state.actionsError) {
    notices.push(`${actionsLabel} unavailable: ${sourceErrorText(state.actionsError)}`);
  } else if (sharedLine) {
    notices.push(`Unavailable: ${unavailableSections.join(", ")}, analyst estimates (${sourceErrorText(state.estimatesError!)})`);
  } else if (unavailableSections.length > 0) {
    notices.push(`Unavailable: ${unavailableSections.join(", ")}`);
  } else if (state.actions && !(state.variant === "earnings-estimates"
    ? state.actions.earnings.some((earning) => earning.epsActual != null)
    : hasCorporateActionRows(state.actions))) {
    notices.push(state.variant === "earnings-estimates"
      ? `No reported earnings for ${state.symbol}`
      : `No dividends, splits, or reported earnings for ${state.symbol}`);
  }

  if (state.actions?.stale) notices.push(`Corporate actions stale${state.actions.fetchedAt ? ` (fetched ${state.actions.fetchedAt})` : ""}`);
  if (state.estimates?.stale) notices.push(`Analyst estimates stale${state.estimates.fetchedAt ? ` (fetched ${state.estimates.fetchedAt})` : ""}`);

  if (state.estimatesError) {
    if (!sharedLine) notices.push(`Analyst estimates unavailable: ${sourceErrorText(state.estimatesError)}`);
  } else if (state.estimates && !hasAnalystEstimates(state.estimates)) {
    notices.push(`No analyst estimates for ${state.symbol}`);
  }

  if (notices.length === 0) return null;
  return {
    text: notices.join("   "),
    failed: !!state.actionsError || !!state.estimatesError || unavailableSections.length > 0 || !!state.actions?.stale || !!state.estimates?.stale,
  };
}

/**
 * A source's failure in words: a reason code reads as what happened
 * ("UPSTREAM_ERROR" is "the source did not answer"); a sentence stands.
 */
export function sourceErrorText(error: string): string {
  return readableStatus(error.trim());
}

function hasCorporateActionRows(data: CorporateActionsData): boolean {
  // A declared dividend is a row too: AIOK's $3.50 special with nothing paid yet.
  return data.dividends.length > 0 || data.splits.length > 0 || data.earnings.length > 0 || declaredDividends(data).length > 0;
}

function hasAnalystEstimates(data: AnalystResearchData): boolean {
  return data.earningsEstimates.length > 0 || data.revenueEstimates.length > 0;
}


export function formatEventMetric(value: number | undefined, currency: string | undefined, kind: "eps" | "revenue"): string {
  if (value == null || !Number.isFinite(value)) return MISSING_VALUE;
  const formatted = kind === "eps" ? formatNumber(value, 2) : formatCompact(value);
  return currency ? `${formatted} ${currency}` : formatted;
}
