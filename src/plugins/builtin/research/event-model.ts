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

export type EventStatus = "Earnings" | "Q Est" | "FY Est" | "TTM" | "Dividend" | "Split";

export interface EventRow {
  id: string;
  date: string;
  dateType?: "announcement" | "fiscal-period-end";
  status: EventStatus;
  period: string;
  detail: string;
  epsCurrency?: string;
  revenueCurrency?: string;
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

function quarterLabel(statement: FinancialStatement | undefined): string {
  return statement?.date ? `Q${statement.date.slice(2)}` : "-";
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
  if (pair.eps?.analysts != null) analystCounts.push(`${pair.eps.analysts}E`);
  if (pair.revenue?.analysts != null) analystCounts.push(`${pair.revenue.analysts}R`);
  if (analystCounts.length) return analystCounts.join("/");
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

function ttmRow(quarterlyStatements: readonly FinancialStatement[], financialCurrency?: string): EventRow | null {
  const latestFour = quarterlyStatements.slice(-4);
  const ttm = computeTTM([...quarterlyStatements]);
  if (!ttm || (ttm.totalRevenue == null && ttm.eps == null)) return null;
  const latest = latestFour.at(-1);
  return {
    id: `ttm:${latest?.date ?? ""}`,
    date: latest?.date ?? "",
    status: "TTM",
    period: "4 qtrs",
    detail: "sum",
    epsCurrency: ttm.currency ?? financialCurrency,
    revenueCurrency: ttm.currency ?? financialCurrency,
    annualEps: ttm.eps,
    annualRevenue: ttm.totalRevenue,
    value: "-",
    tone: "muted",
  };
}

function earningsDetail(earning: CorporateActionsData["earnings"][number]): string {
  if (earning.epsActual == null) return "Pending";
  const detail = earning.difference == null ? "Reported" : `diff ${formatNumber(earning.difference, 2)}`;
  return earning.dateType === "fiscal-period-end" ? `Period end; ${detail}` : detail;
}

function eventSortRank(status: EventStatus): number {
  switch (status) {
    case "Q Est": return 0;
    case "FY Est": return 1;
    case "Earnings": return 2;
    case "TTM": return 3;
    case "Dividend": return 4;
    case "Split": return 5;
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
  const ttm = ttmRow(quarterlyStatements, financials?.financialCurrency);
  if (ttm) rows.push(ttm);

  for (const earning of data?.earnings ?? []) {
    // A pending announcement must never inherit the previous report's actuals.
    const statement = earning.epsActual == null ? undefined : statementForEarningsDate(quarterlyStatements, earning);
    rows.push({
      id: `earn:${earning.date}`,
      date: statement?.date ?? earning.date,
      dateType: earning.dateType,
      status: "Earnings",
      period: statement ? quarterLabel(statement) : earning.time?.trim() || "-",
      detail: earningsDetail(earning),
      epsCurrency: earning.currency,
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

  for (const pair of buildEstimatePairs(estimates)) {
    const isFiscal = isFiscalEstimatePeriod(pair.period);
    rows.push({
      id: `estimate:${pair.date}:${pair.period}`,
      date: pair.date,
      status: isFiscal ? "FY Est" : "Q Est",
      period: formatPeriod(pair.period),
      detail: formatEstimateDetail(pair),
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
      status: "Split",
      period: "-",
      detail: split.description ?? "Split",
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
  } else if (state.actions && !hasCorporateActionRows(state.actions)) {
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
