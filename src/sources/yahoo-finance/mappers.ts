import type { EarningsEstimateBasis, EarningsEstimateField, EarningsEvent } from "../../types/data-provider";
import type {
  AnalystEstimateRecord,
  AnalystResearchData,
  CorporateActionsData,
  DividendAction,
  EarningsAction,
  MarketState,
  SplitAction,
} from "../../types/financials";
import { resolveCurrencyUnit } from "../../utils/currency-units";
import { zonedDateTimeParts } from "../../utils/zoned-date-time";
import type { ChartResult, YahooEarningsTrend, YahooQuoteSummaryResult } from "./types";
import { yahooSecurityName } from "./names";

export type ExtendedHoursData = {
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
};

export function normalizeSubUnitCurrency(currency: string): { currency: string; divisor: number } {
  return resolveCurrencyUnit(currency);
}

export function financeRawNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value && typeof value === "object") {
    const raw = (value as { raw?: unknown }).raw;
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  }
  return undefined;
}

function financeRawNumberOrNull(value: unknown): number | null {
  return financeRawNumber(value) ?? null;
}

export function hasAnalystResearchValue(data: AnalystResearchData): boolean {
  return !!data.priceTarget
    || data.recommendations.length > 0
    || data.ratings.length > 0
    || data.earningsEstimates.length > 0
    || data.revenueEstimates.length > 0;
}

export function hasCorporateActionsValue(data: CorporateActionsData): boolean {
  return data.dividends.length > 0
    || data.splits.length > 0
    || data.earnings.length > 0;
}

export function normalizePositiveMarketValue(value: number | undefined, divisor = 1): number | undefined {
  if (value == null || !Number.isFinite(value) || value <= 0) return undefined;
  return value / divisor;
}

export function normalizeMarketValue(value: number | undefined, divisor = 1): number | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  return value / divisor;
}

function yahooRawDateTime(value: unknown): Date | null {
  const raw = financeRawNumber(value);
  if (raw == null) return null;
  const date = new Date(raw * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function yahooRawDate(value: unknown): string | undefined {
  if (value && typeof value === "object") {
    const fmt = (value as { fmt?: unknown }).fmt;
    if (typeof fmt === "string" && /^\d{4}-\d{2}-\d{2}$/.test(fmt)) return fmt;
  }
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const raw = financeRawNumber(value);
  if (raw == null) return undefined;
  const date = new Date(raw * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10);
}

function inferEarningsTiming(date: Date): EarningsEvent["timing"] {
  if (date.getUTCHours() === 0 && date.getUTCMinutes() === 0 && date.getUTCSeconds() === 0) {
    return "";
  }
  const hour = date.getUTCHours();
  if (hour >= 20) return "AMC";
  if (hour <= 13) return "BMO";
  return "";
}

export function deriveShareChange(position: number | undefined, changePercent: number | undefined): number | undefined {
  if (position == null || changePercent == null || !Number.isFinite(position) || !Number.isFinite(changePercent)) return undefined;
  const denominator = 1 + changePercent;
  if (denominator <= 0) return undefined;
  return Math.round(position - position / denominator);
}

export function mapYahooAnalystResearchResponse(
  result: YahooQuoteSummaryResult,
  fallbackSymbol: string,
): AnalystResearchData {
  const financialData = result.financialData;
  const unit = resolveCurrencyUnit(result.price?.currency);
  const priceValue = (value: unknown) => normalizeMarketValue(financeRawNumber(value), unit.divisor);
  const targetHigh = priceValue(financialData?.targetHighPrice);
  const targetLow = priceValue(financialData?.targetLowPrice);
  const targetMean = priceValue(financialData?.targetMeanPrice);
  const targetMedian = priceValue(financialData?.targetMedianPrice);
  const currentPrice = priceValue(financialData?.currentPrice);
  const trend = result.earningsTrend?.trend ?? [];

  return {
    providerId: "yahoo",
    fetchedAt: new Date().toISOString(),
    symbol: result.price?.symbol ?? fallbackSymbol,
    name: yahooSecurityName(result.price?.shortName, result.price?.longName),
    currency: unit.currency || undefined,
    exchange: result.price?.exchangeName,
    priceTarget: targetHigh != null || targetLow != null || targetMean != null || targetMedian != null
      ? {
          high: targetHigh,
          median: targetMedian,
          low: targetLow,
          average: targetMean,
          current: currentPrice,
          currency: unit.currency || undefined,
        }
      : undefined,
    recommendationRating: yahooRecommendationMeanToRating(financeRawNumber(financialData?.recommendationMean)),
    recommendations: (result.recommendationTrend?.trend ?? [])
      .filter((row) => row.period)
      .map((row) => ({
        period: normalizeYahooRecommendationPeriod(row.period),
        strongBuy: row.strongBuy,
        buy: row.buy,
        hold: row.hold,
        sell: row.sell,
        strongSell: row.strongSell,
      })),
    ratings: (result.upgradeDowngradeHistory?.history ?? [])
      .map((rating): AnalystResearchData["ratings"][number] | null => {
        const firm = rating.firm?.trim();
        const date = rating.epochGradeDate
          ? new Date(rating.epochGradeDate * 1000).toISOString().slice(0, 10)
          : "";
        if (!firm || !date) return null;
        const action = normalizeYahooRatingAction(rating.action, rating.priceTargetAction);
        const current = rating.toGrade?.trim();
        const prior = rating.fromGrade?.trim();
        const currentPriceTarget = priceValue(rating.currentPriceTarget);
        const priorPriceTarget = priceValue(rating.priorPriceTarget);
        // A grade-only action uses two zero sentinels, not an explicit $0 target.
        const emptyTargets = currentPriceTarget === 0 && priorPriceTarget === 0 && !rating.priceTargetAction?.trim();
        // A firm setting its first target reports the missing prior as 0.
        const firstTarget = priorPriceTarget === 0 && currentPriceTarget != null && currentPriceTarget > 0;
        return {
          date,
          firm,
          ...(action ? { action } : {}),
          ...(current ? { current } : {}),
          ...(prior ? { prior } : {}),
          ...(!emptyTargets && currentPriceTarget != null ? { currentPriceTarget } : {}),
          ...(!emptyTargets && !firstTarget && priorPriceTarget != null ? { priorPriceTarget } : {}),
        };
      })
      .filter((rating): rating is AnalystResearchData["ratings"][number] => rating !== null)
      .sort((left, right) => right.date.localeCompare(left.date))
      .slice(0, 100),
    earningsEstimates: trend
      .map((row) => mapYahooEstimate(row, row.earningsEstimate, "yearAgoEps"))
      .filter((estimate): estimate is AnalystEstimateRecord => estimate !== null),
    revenueEstimates: trend
      .map((row) => mapYahooEstimate(row, row.revenueEstimate, "yearAgoRevenue"))
      .filter((estimate): estimate is AnalystEstimateRecord => estimate !== null),
  };
}

/**
 * Yahoo's chart dividends carry float and adjustment residue: 2330.TW's
 * declared NT$7.00, 4.00 and 3.50 arrive as 7.000001, 3.999637 and 3.49979.
 * Amounts converted from another currency are legitimately that fine
 * (VOD.L's 2.0301435p), so only a series whose every fine amount sits within
 * 0.01% of a whole cent is read in cents; a lone amount needs 0.001%.
 */
export function cleanYahooDividendAmounts(amounts: number[]): number[] {
  const residue = (amount: number) => {
    const text = String(amount);
    const cents = Math.round(amount * 100) / 100;
    return !text.includes("e") && (text.split(".")[1]?.length ?? 0) >= 5 && cents !== 0
      ? Math.abs(amount - cents) / Math.abs(amount) : undefined;
  };
  const fine = amounts.map(residue).filter((value): value is number => value !== undefined);
  const limit = fine.length >= 3 && fine.every((value) => value <= 1e-4) ? 1e-4 : 1e-5;
  return amounts.map((amount) => (residue(amount) ?? 1) <= limit ? Math.round(amount * 100) / 100 : amount);
}

export function mapYahooDividends(events: ChartResult["events"], meta?: ChartResult["meta"]): DividendAction[] {
  const dividends = Object.values(events?.dividends ?? {})
    .map((dividend): DividendAction | null => {
      const date = yahooTimestampDate(dividend.date, meta?.exchangeTimezoneName);
      if (!date || dividend.amount == null || !Number.isFinite(dividend.amount)) return null;
      return { exDate: date, amount: dividend.amount };
    })
    .filter((dividend): dividend is DividendAction => dividend !== null);
  const amounts = cleanYahooDividendAmounts(dividends.map((dividend) => dividend.amount));
  return dividends.map((dividend, index) =>
    amounts[index] === dividend.amount ? dividend : { ...dividend, amount: amounts[index]! });
}

export function mapYahooSplits(events: ChartResult["events"], meta?: ChartResult["meta"]): SplitAction[] {
  return Object.values(events?.splits ?? {})
    .map((split): SplitAction | null => {
      const date = yahooTimestampDate(split.date, meta?.exchangeTimezoneName);
      if (!date) return null;
      const numerator = split.numerator;
      const denominator = split.denominator;
      return {
        date,
        description: split.splitRatio ? `${split.splitRatio} split` : "Split",
        ratio: numerator != null && denominator ? numerator / denominator : undefined,
        fromFactor: denominator,
        toFactor: numerator,
      };
    })
    .filter((split): split is SplitAction => split !== null);
}

/** Quarter ends closer than this are the same fiscal quarter under different normalizations. */
const SAME_QUARTER_MS = 45 * 86_400_000;

/**
 * Yahoo can keep serving the "0q" trend after that quarter has been reported
 * (ORCL in Sep 2026 listed the reported Aug quarter against its December date).
 * Its consensus then describes a past period, and calendarEvents copies it.
 * Only an announcement on a later UTC day than today can belong to the next
 * quarter: on report day history may carry the actual before the date rolls.
 */
function yahooReportedQuarterTrend(result: YahooQuoteSummaryResult, now: number): YahooEarningsTrend | undefined {
  const announcement = financeRawNumber(result.calendarEvents?.earnings?.earningsDate?.[0]);
  if (announcement == null || Math.floor(announcement / 86_400) <= Math.floor(now / 86_400_000)) return undefined;
  const currentQtr = result.earningsTrend?.trend?.find((trend) => trend.period === "0q");
  const periodEnd = currentQtr?.endDate ? Date.parse(currentQtr.endDate) : Number.NaN;
  if (!Number.isFinite(periodEnd)) return undefined;
  const reported = (result.earningsHistory?.history ?? [])
    .filter((earning) => financeRawNumber(earning.epsActual) != null)
    .map((earning) => Date.parse(yahooRawDate(earning.quarter) ?? ""))
    .filter(Number.isFinite);
  return reported.some((reportedEnd) => periodEnd - reportedEnd < SAME_QUARTER_MS) ? currentQtr : undefined;
}

/** A calendar value copied from an already reported quarter's trend is not a forecast for the upcoming date. */
function staleCalendarValue(value: unknown, staleTrendValue: unknown): unknown {
  const raw = financeRawNumber(value);
  return raw != null && raw === financeRawNumber(staleTrendValue) ? undefined : value;
}

export function mapYahooCalendarEarnings(result: YahooQuoteSummaryResult, now = Date.now()): EarningsAction[] {
  const rawDate = result.calendarEvents?.earnings?.earningsDate?.[0];
  const date = yahooRawDate(rawDate);
  if (!date) return [];
  const timestamp = yahooRawDateTime(rawDate);
  const staleTrend = yahooReportedQuarterTrend(result, now);
  const epsEstimate = financeRawNumber(staleCalendarValue(result.calendarEvents?.earnings?.earningsAverage, staleTrend?.earningsEstimate?.avg));
  // calendarEvents carries no currency; a value copied from the current
  // quarter's trend can use that trend's earnings currency.
  const trendEstimate = staleTrend ? undefined : result.earningsTrend?.trend?.find((trend) => trend.period === "0q")?.earningsEstimate;
  const unit = epsEstimate != null && epsEstimate === financeRawNumber(trendEstimate?.avg)
    ? resolveCurrencyUnit(trendEstimate?.earningsCurrency)
    : undefined;
  const currency = unit && /^[A-Z]{3}$/.test(unit.currency) ? unit.currency : undefined;
  return [{
    date,
    dateType: "announcement",
    ...(currency ? { currency } : {}),
    time: timestamp ? inferEarningsTiming(timestamp) : undefined,
    epsEstimate: currency ? normalizeMarketValue(epsEstimate, unit!.divisor) : epsEstimate,
  }];
}

export function mapYahooEarningsHistory(result: YahooQuoteSummaryResult): EarningsAction[] {
  return (result.earningsHistory?.history ?? [])
    .map((earning): EarningsAction | null => {
      const date = yahooRawDate(earning.quarter);
      if (!date) return null;
      const surprisePercent = financeRawNumber(earning.surprisePercent);
      const unit = resolveCurrencyUnit(earning.currency);
      const monetaryValue = (value: unknown) => normalizeMarketValue(financeRawNumber(value), unit.divisor);
      return {
        date,
        dateType: "fiscal-period-end",
        currency: unit.currency || undefined,
        epsEstimate: monetaryValue(earning.epsEstimate),
        epsActual: monetaryValue(earning.epsActual),
        difference: monetaryValue(earning.epsDifference),
        surprisePercent: surprisePercent == null ? undefined : surprisePercent * 100,
      };
    })
    .filter((earning): earning is EarningsAction => earning !== null);
}

export function mapYahooEarningsCalendarEvent(
  result: YahooQuoteSummaryResult,
  symbol: string,
  now = Date.now(),
): EarningsEvent | null {
  const cal = result.calendarEvents?.earnings;
  if (!cal?.earningsDate?.length) return null;

  const earningsDate = new Date((cal.earningsDate[0]!.raw ?? 0) * 1000);
  if (Number.isNaN(earningsDate.getTime())) return null;

  const staleTrend = yahooReportedQuarterTrend(result, now);
  const currentQtr = staleTrend ? undefined : result.earningsTrend?.trend?.find((trend) => trend.period === "0q");
  const staleEps = staleTrend?.earningsEstimate;
  const staleRevenue = staleTrend?.revenueEstimate;
  const earningsEstimate = currentQtr?.earningsEstimate;
  const revenueEstimate = currentQtr?.revenueEstimate;
  const epsTrend = currentQtr?.epsTrend;
  const epsRevisions = currentQtr?.epsRevisions;

  const estimateBasis: NonNullable<EarningsEvent["estimateBasis"]> = {};
  const period = currentQtr?.period?.trim() || null;
  const rawEnd = currentQtr?.endDate;
  const periodEndDate = typeof rawEnd === "string" && /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
    && Number.isFinite(Date.parse(rawEnd)) && new Date(rawEnd).toISOString().slice(0, 10) === rawEnd
    ? rawEnd : null;
  const estimateValue = (
    field: EarningsEstimateField,
    trendValue: unknown,
    calendarValue?: unknown,
    sourceCurrency?: string,
    monetary = false,
  ): number | null => {
    // Keep the existing selection rule, but never attach trend metadata to a
    // value selected from the independent calendar module.
    const fromTrend = trendValue != null;
    const raw = financeRawNumber(fromTrend ? trendValue : calendarValue);
    if (raw == null) return null;
    const rawCurrency = fromTrend ? sourceCurrency?.trim() || null : null;
    const unit = resolveCurrencyUnit(rawCurrency);
    const currency = /^[A-Z]{3}$/.test(unit.currency) && unit.currency !== "XXX" ? unit.currency : null;
    const basis: EarningsEstimateBasis = {
      source: fromTrend ? "earningsTrend" : "calendarEvents",
      sourceValue: raw,
      period: fromTrend ? period : null,
      periodEndDate: fromTrend ? periodEndDate : null,
      ...(monetary ? { currency, sourceCurrency: rawCurrency } : {}),
    };
    estimateBasis[field] = basis;
    return monetary ? raw / unit.divisor : raw;
  };

  return {
    symbol,
    name: yahooSecurityName(result.quoteType?.shortName, result.quoteType?.longName) || symbol,
    earningsDate,
    earningsCallDate: yahooRawDateTime(cal.earningsCallDate?.[0]),
    isDateEstimate: cal.isEarningsDateEstimate ?? null,
    epsEstimate: estimateValue("epsEstimate", earningsEstimate?.avg, staleCalendarValue(cal.earningsAverage, staleEps?.avg), earningsEstimate?.earningsCurrency, true),
    epsLow: estimateValue("epsLow", earningsEstimate?.low, staleCalendarValue(cal.earningsLow, staleEps?.low), earningsEstimate?.earningsCurrency, true),
    epsHigh: estimateValue("epsHigh", earningsEstimate?.high, staleCalendarValue(cal.earningsHigh, staleEps?.high), earningsEstimate?.earningsCurrency, true),
    epsYearAgo: estimateValue("epsYearAgo", earningsEstimate?.yearAgoEps, undefined, earningsEstimate?.earningsCurrency, true),
    epsGrowth: estimateValue("epsGrowth", earningsEstimate?.growth),
    epsAnalysts: estimateValue("epsAnalysts", earningsEstimate?.numberOfAnalysts),
    epsTrend7dAgo: estimateValue("epsTrend7dAgo", epsTrend?.["7daysAgo"], undefined, epsTrend?.epsTrendCurrency, true),
    epsTrend30dAgo: estimateValue("epsTrend30dAgo", epsTrend?.["30daysAgo"], undefined, epsTrend?.epsTrendCurrency, true),
    epsRevisionUp7d: estimateValue("epsRevisionUp7d", epsRevisions?.upLast7days),
    epsRevisionUp30d: estimateValue("epsRevisionUp30d", epsRevisions?.upLast30days),
    epsRevisionDown7d: estimateValue("epsRevisionDown7d", epsRevisions?.downLast7Days),
    epsRevisionDown30d: estimateValue("epsRevisionDown30d", epsRevisions?.downLast30days),
    epsActual: null,
    revenueEstimate: estimateValue("revenueEstimate", revenueEstimate?.avg, staleCalendarValue(cal.revenueAverage, staleRevenue?.avg), revenueEstimate?.revenueCurrency, true),
    revenueLow: estimateValue("revenueLow", revenueEstimate?.low, staleCalendarValue(cal.revenueLow, staleRevenue?.low), revenueEstimate?.revenueCurrency, true),
    revenueHigh: estimateValue("revenueHigh", revenueEstimate?.high, staleCalendarValue(cal.revenueHigh, staleRevenue?.high), revenueEstimate?.revenueCurrency, true),
    revenueYearAgo: estimateValue("revenueYearAgo", revenueEstimate?.yearAgoRevenue, undefined, revenueEstimate?.revenueCurrency, true),
    revenueGrowth: estimateValue("revenueGrowth", revenueEstimate?.growth),
    revenueAnalysts: estimateValue("revenueAnalysts", revenueEstimate?.numberOfAnalysts),
    revenueActual: null,
    surprise: null,
    timing: inferEarningsTiming(earningsDate),
    estimateBasis,
  };
}

export function deriveMarketState(meta: NonNullable<ChartResult["meta"]>): MarketState {
  const ctp = meta.currentTradingPeriod;
  if (!ctp) return "CLOSED";
  const now = Math.floor(Date.now() / 1000);
  if (ctp.regular?.start && ctp.regular?.end && now >= ctp.regular.start && now < ctp.regular.end) return "REGULAR";
  if (ctp.pre?.start && ctp.pre?.end && now >= ctp.pre.start && now < ctp.pre.end) return "PRE";
  if (ctp.post?.start && ctp.post?.end && now >= ctp.post.start && now < ctp.post.end) return "POST";
  return "CLOSED";
}

export function extractExtendedHoursPrices(
  meta: NonNullable<ChartResult["meta"]>,
  timestamps: number[],
  closes: (number | null)[],
  marketState: MarketState,
  regularCloseOverride?: number,
): ExtendedHoursData {
  const ctp = meta.currentTradingPeriod;
  if (!ctp || !timestamps.length) return {};

  const regStart = ctp.regular?.start ?? 0;
  const regEnd = ctp.regular?.end ?? Infinity;
  const regularClose = regularCloseOverride ?? meta.regularMarketPrice ?? meta.chartPreviousClose;

  if (marketState === "PRE") {
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (timestamps[i]! < regStart && closes[i] != null) {
        const ext = computeExtendedHoursChange(closes[i]!, regularClose);
        return { preMarketPrice: closes[i]!, preMarketChange: ext.change, preMarketChangePercent: ext.changePct };
      }
    }
  } else if (marketState === "POST") {
    for (let i = timestamps.length - 1; i >= 0; i--) {
      if (timestamps[i]! >= regEnd && closes[i] != null) {
        const ext = computeExtendedHoursChange(closes[i]!, regularClose);
        return { postMarketPrice: closes[i]!, postMarketChange: ext.change, postMarketChangePercent: ext.changePct };
      }
    }
  }
  return {};
}

function normalizeYahooRecommendationPeriod(period?: string): string {
  switch (period) {
    case "0m":
      return "current month";
    case "-1m":
      return "previous month";
    case "-2m":
      return "previous 2 months";
    case "-3m":
      return "previous 3 months";
    case "0q":
      return "current quarter";
    case "+1q":
      return "next quarter";
    case "0y":
      return "current year";
    case "+1y":
      return "next year";
    default:
      return period ?? "";
  }
}

function normalizeYahooRatingAction(action?: string, priceTargetAction?: string): string | undefined {
  const targetAction = priceTargetAction?.trim();
  switch ((action ?? "").toLowerCase()) {
    case "up":
      return "Upgrade";
    case "down":
      return "Downgrade";
    case "init":
      return "Initiated";
    case "reit":
      return targetAction || "Reiterated";
    case "main":
      return targetAction || "Maintained";
    default:
      return action?.trim() || undefined;
  }
}

function yahooRecommendationMeanToRating(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  return Math.max(0, Math.min(10, ((5 - value) / 4) * 10));
}

function mapYahooEstimate(
  trend: YahooEarningsTrend,
  estimate: unknown,
  yearAgoKey: "yearAgoEps" | "yearAgoRevenue",
): AnalystEstimateRecord | null {
  if (!estimate || typeof estimate !== "object") return null;
  const record = estimate as Record<string, unknown>;
  const rawCurrency = record[yearAgoKey === "yearAgoEps" ? "earningsCurrency" : "revenueCurrency"];
  const unit = resolveCurrencyUnit(typeof rawCurrency === "string" ? rawCurrency : undefined);
  const monetaryValue = (value: unknown) => normalizeMarketValue(financeRawNumber(value), unit.divisor);
  const average = monetaryValue(record.avg);
  const low = monetaryValue(record.low);
  const high = monetaryValue(record.high);
  const analysts = financeRawNumber(record.numberOfAnalysts);
  const yearAgo = monetaryValue(record[yearAgoKey]);
  const growth = financeRawNumber(record.growth);
  // Yahoo emits all-zero placeholders for periods with no analyst coverage.
  if (analysts === 0 && [average, low, high, yearAgo, growth].every((value) => value == null || value === 0)) return null;
  if (
    average == null
    && low == null
    && high == null
    && analysts == null
    && yearAgo == null
    && growth == null
  ) {
    return null;
  }
  return {
    date: trend.endDate ?? "",
    currency: unit.currency || undefined,
    period: normalizeYahooRecommendationPeriod(trend.period),
    analysts,
    average,
    low,
    high,
    yearAgo,
    growth,
  };
}

function yahooTimestampDate(value: number | undefined, exchangeTimeZone?: string): string | undefined {
  if (value == null || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  // Chart action timestamps are instants. Use the historical exchange-local date,
  // not today's GMT offset, which can differ because of daylight saving time.
  if (exchangeTimeZone) {
    try {
      const { year, month, day } = zonedDateTimeParts(date.getTime(), exchangeTimeZone);
      return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    } catch {
      // Preserve the existing UTC fallback when the provider supplies no usable timezone.
    }
  }
  return date.toISOString().slice(0, 10);
}

function computeExtendedHoursChange(
  extPrice: number | undefined,
  regularPrice: number | undefined,
): { change?: number; changePct?: number } {
  if (extPrice == null || regularPrice == null || regularPrice === 0) return {};
  const change = extPrice - regularPrice;
  return { change, changePct: (change / regularPrice) * 100 };
}
