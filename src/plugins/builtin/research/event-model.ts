import type {
  AnalystEstimateRecord,
  AnalystResearchData,
  CorporateActionsData,
  FinancialStatement,
  TickerFinancials,
} from "../../../types/financials";
import {
  formatDistributionAmount,
  formatCompact,
  formatNumber,
  formatPercent,
  formatPercentRaw,
} from "../../../utils/format";
import { computeTTM } from "../ticker-detail/financials/aggregation";

export const CORPORATE_ACTION_COVERAGE = "Split-feed factors may include spinoff price adjustments. Merger terms, spinoff distributions, and security conversions are not covered.";

export type EventStatus = "Earnings" | "Q Est" | "FY Est" | "TTM" | "Dividend" | "Factor";

export interface EventRow {
  id: string;
  date: string;
  dateType?: "announcement" | "fiscal-period-end";
  status: EventStatus;
  period: string;
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
  epsBasis?: "provider-unspecified";
  providerId?: string;
  fetchedAt?: string;
  /** Keep the supplied ranges and comparison inputs available in detail/export. */
  estimateInputs?: { eps?: AnalystEstimateRecord; revenue?: AnalystEstimateRecord };
  estimateGrowthMetric?: "eps" | "revenue";
  fiscalPeriodEnd?: string;
  periodDateSource?: FinancialStatement["dateSource"];
  providerPeriodDate?: string;
  dateEvidence?: FinancialStatement["dateEvidence"];
  annualEps?: number;
  annualRevenue?: number;
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
    || "-";
}

function isFiscalEstimatePeriod(period: string): boolean {
  return /\byear\b|^current_year$|^next_year$|^next_5y$/i.test(period);
}

function sortedQuarterlyStatements(
  financials: Pick<TickerFinancials, "quarterlyStatements"> | null,
): FinancialStatement[] {
  return [...(financials?.quarterlyStatements ?? [])]
    .filter((statement) => statement.date)
    .sort((left, right) => left.date.localeCompare(right.date));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The quarter by the month it ends in, e.g. "Jun 2026". */
function quarterLabel(statement: FinancialStatement | undefined): string {
  const match = /^(\d{4})-(\d{2})/.exec(statement?.date ?? "");
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${month} ${match[1]}` : "-";
}

function statementForEarningsDate(
  quarterlyStatements: readonly FinancialStatement[],
  earning: CorporateActionsData["earnings"][number],
): FinancialStatement | undefined {
  // Announcement proximity cannot establish which quarter a result describes.
  // Vendor period aliases are usable only when the statement retains that identity.
  if (earning.dateType !== "fiscal-period-end") return undefined;
  const matches = quarterlyStatements.filter((statement) => statement.date === earning.date || statement.providerDate === earning.date);
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

function formatEstimateDetail(pair: EstimatePair): string {
  const analystCounts: string[] = [];
  if (pair.eps?.analysts != null) analystCounts.push(`${pair.eps.analysts} EPS`);
  if (pair.revenue?.analysts != null) analystCounts.push(`${pair.revenue.analysts} rev`);
  if (analystCounts.length) return `${analystCounts.join(" / ")} analysts`;
  return "Consensus";
}

function estimateTone(pair: EstimatePair): EventRow["tone"] {
  const growth = pair.eps?.growth ?? pair.revenue?.growth;
  if (growth == null) return "muted";
  return growth >= 0 ? "positive" : "negative";
}

function estimateValue(pair: EstimatePair): string {
  const growth = pair.eps?.growth ?? pair.revenue?.growth;
  return growth == null ? "-" : formatPercent(growth);
}

/**
 * The TTM row sits under the reported quarters, so its EPS sums those rows'
 * provider EPS (often adjusted) rather than statement GAAP EPS whenever the
 * four statement quarters each have a reported row.
 */
function reportedTtmEps(
  latestFour: readonly FinancialStatement[],
  earnings: CorporateActionsData["earnings"],
): { eps: number; currency?: string } | null {
  if (latestFour.length < 4) return null;
  const reported = earnings.filter((earning) => earning.epsActual != null);
  const quarters = latestFour.map((statement) => {
    const matches = reported.filter((earning) => statementForEarningsDate([statement], earning) === statement);
    return matches.length === 1 ? matches[0]! : null;
  });
  if (quarters.some((earning) => earning == null)) return null;
  const currencies = new Set(quarters.map((earning) => earning!.currency));
  if (currencies.size !== 1) return null;
  return { eps: quarters.reduce((sum, earning) => sum + earning!.epsActual!, 0), currency: quarters[0]!.currency };
}

function ttmRow(
  quarterlyStatements: readonly FinancialStatement[],
  earnings: CorporateActionsData["earnings"],
  financialCurrency?: string,
): EventRow | null {
  const latestFour = quarterlyStatements.slice(-4);
  const ttm = computeTTM([...quarterlyStatements]);
  if (!ttm || (ttm.totalRevenue == null && ttm.eps == null)) return null;
  const latest = latestFour.at(-1);
  const reportedEps = reportedTtmEps(latestFour, earnings);
  return {
    id: `ttm:${latest?.date ?? ""}`,
    date: latest?.date ?? "",
    status: "TTM",
    period: "4 qtrs",
    // Statement EPS is not the sum of the (often adjusted) rows above it.
    detail: !reportedEps && ttm.eps != null ? "statement EPS" : "sum",
    epsCurrency: reportedEps ? reportedEps.currency : ttm.currency ?? financialCurrency,
    revenueCurrency: ttm.currency ?? financialCurrency,
    annualEps: reportedEps ? reportedEps.eps : ttm.eps,
    annualRevenue: ttm.totalRevenue,
    value: "-",
    tone: "muted",
  };
}

function earningsDetail(earning: CorporateActionsData["earnings"][number]): string {
  if (earning.epsActual == null) return "Pending";
  const detail = earning.difference == null
    ? "Reported"
    : `${earning.difference > 0 ? "+" : ""}${formatNumber(earning.difference, 2)} vs est`;
  return earning.dateType === "fiscal-period-end" ? `Period end; ${detail}` : detail;
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
    .filter((earning) => earning.epsActual != null && earning.dateType === "fiscal-period-end")
    .flatMap((earning) => [earning.date, statementForEarningsDate(quarterlyStatements, earning)?.date])
    .map((date) => Date.parse(date ?? ""))
    .filter(Number.isFinite);
}

/**
 * Yahoo can keep serving a reported quarter as "0q" until its trend rolls
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
    case "Factor": return 5;
  }
}

export function buildEventRows(
  data: CorporateActionsData | null,
  estimates: AnalystResearchData | null,
  financials: Pick<TickerFinancials, "quarterlyStatements" | "financialCurrency"> | null,
  currency: string,
): EventRow[] {
  const rows: EventRow[] = [];
  const quarterlyStatements = sortedQuarterlyStatements(financials);
  const earnings = data?.earnings ?? [];
  const ttm = ttmRow(quarterlyStatements, earnings, financials?.financialCurrency);
  if (ttm) rows.push(ttm);

  const earningsIds = earningsRowIds(earnings);
  // An upcoming report often arrives without a currency; the feed's reported
  // quarters give it when they all agree on one.
  const feedCurrencies = new Set(earnings.map((earning) => earning.currency).filter(Boolean));
  const feedCurrency = feedCurrencies.size === 1 ? [...feedCurrencies][0] : undefined;
  for (const [index, earning] of earnings.entries()) {
    // A pending announcement must never inherit the previous report's actuals.
    const statement = earning.epsActual == null ? undefined : statementForEarningsDate(quarterlyStatements, earning);
    rows.push({
      id: earningsIds[index]!,
      date: statement?.date ?? earning.date,
      dateType: earning.dateType,
      status: "Earnings",
      period: statement ? quarterLabel(statement) : earning.time?.trim() || "-",
      detail: earningsDetail(earning),
      epsCurrency: earning.currency ?? (earning.epsActual == null ? feedCurrency : undefined),
      revenueCurrency: statement ? statement.currency ?? financials?.financialCurrency : undefined,
      qEps: earning.epsActual ?? earning.epsEstimate,
      qRevenue: statement?.totalRevenue,
      earningsState: earning.epsActual == null ? "pending" : "reported",
      epsActual: earning.epsActual,
      epsEstimate: earning.epsEstimate,
      epsDifference: earning.epsActual == null ? undefined : earning.difference,
      surprisePercent: earning.epsActual == null ? undefined : earning.surprisePercent,
      epsBasis: "provider-unspecified",
      providerId: data?.providerId,
      fetchedAt: data?.fetchedAt,
      fiscalPeriodEnd: statement?.date,
      periodDateSource: statement?.dateSource,
      providerPeriodDate: earning.dateType === "fiscal-period-end" ? earning.date : undefined,
      dateEvidence: statement?.dateEvidence,
      value: earning.epsActual != null && earning.surprisePercent != null ? formatPercentRaw(earning.surprisePercent) : "-",
      tone: earning.epsActual == null || earning.surprisePercent == null ? "muted" : earning.surprisePercent >= 0 ? "positive" : "negative",
    });
  }

  const reportedPeriodEnds = reportedPeriodTimes(earnings, quarterlyStatements);
  for (const pair of buildEstimatePairs(estimates)) {
    const isFiscal = isFiscalEstimatePeriod(pair.period);
    if (!isFiscal && isReportedQuarter(pair.date, reportedPeriodEnds)) continue;
    rows.push({
      id: `estimate:${pair.date}:${pair.period}`,
      date: pair.date,
      status: isFiscal ? "FY Est" : "Q Est",
      period: formatPeriod(pair.period),
      detail: formatEstimateDetail(pair),
      providerId: estimates?.providerId,
      fetchedAt: estimates?.fetchedAt,
      estimateInputs: {
        ...(pair.eps ? { eps: { ...pair.eps } } : {}),
        ...(pair.revenue ? { revenue: { ...pair.revenue } } : {}),
      },
      estimateGrowthMetric: pair.eps?.growth != null ? "eps" : pair.revenue?.growth != null ? "revenue" : undefined,
      epsCurrency: pair.eps?.currency,
      revenueCurrency: pair.revenue?.currency,
      qEps: isFiscal ? undefined : pair.eps?.average,
      qRevenue: isFiscal ? undefined : pair.revenue?.average,
      annualEps: isFiscal ? pair.eps?.average : undefined,
      annualRevenue: isFiscal ? pair.revenue?.average : undefined,
      value: estimateValue(pair),
      tone: estimateTone(pair),
    });
  }

  for (const dividend of data?.dividends ?? []) {
    rows.push({
      id: `div:${dividend.exDate}`,
      date: dividend.exDate,
      status: "Dividend",
      period: "-",
      detail: "Ex-date",
      value: formatDistributionAmount(dividend.amount, data?.currency ?? currency),
      tone: "positive",
    });
  }

  for (const split of data?.splits ?? []) {
    rows.push({
      id: `split:${split.date}:${split.description ?? ""}`,
      date: split.date,
      status: "Factor",
      period: "-",
      detail: "Split/adjustment",
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

  if (state.actionsError) {
    notices.push(`${actionsLabel} unavailable: ${state.actionsError}`);
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
    notices.push(`Analyst estimates unavailable: ${state.estimatesError}`);
  } else if (state.estimates && !hasAnalystEstimates(state.estimates)) {
    notices.push(`No analyst estimates for ${state.symbol}`);
  }

  if (notices.length === 0) return null;
  return {
    text: notices.join("   "),
    failed: !!state.actionsError || !!state.estimatesError || unavailableSections.length > 0 || !!state.actions?.stale || !!state.estimates?.stale,
  };
}

function hasCorporateActionRows(data: CorporateActionsData): boolean {
  return data.dividends.length > 0 || data.splits.length > 0 || data.earnings.length > 0;
}

function hasAnalystEstimates(data: AnalystResearchData): boolean {
  return data.earningsEstimates.length > 0 || data.revenueEstimates.length > 0;
}


export function formatEventMetric(value: number | undefined, currency: string | undefined, kind: "eps" | "revenue"): string {
  if (value == null || !Number.isFinite(value)) return "-";
  const formatted = kind === "eps" ? formatNumber(value, 2) : formatCompact(value);
  return currency ? `${formatted} ${currency}` : formatted;
}
