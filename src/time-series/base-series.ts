import { resolveAssetDisplayKind } from "../market-data/market/format";
import { hasValidQuoteObservationTime } from "../market-data/quotes/freshness";
import type { HistorySession } from "../types/price-history";
import { appendLiveQuotePoint, hasUnknownBondHistoryBasis } from "./chart-data";
import type { LiveBarAccumulator } from "./live-bars";
import { CHART_RESOLUTION_STEP_MS, type ManualChartResolution } from "./resolution";
import type { Quote, QuoteMetadata, TickerFinancials } from "../types/financials";
import type { FredSeriesLoadResult } from "../sources/gloomberb-cloud/fred-series";
import { extractFredSeries } from "./economic";
import { getTimeSeriesField, isMarketFieldId } from "./field-catalog";
import {
  unreportedStatementPeriod,
  dailyValuationFallbackPeriod,
  valuationCurrencyWarning,
  valuationPriceIssues,
} from "./fundamentals";
import { extractSecuritySeries } from "./market";
import { activeStudyInputSeriesIds } from "./studies";
import { reportingCurrencySeries } from "./reporting-currency";
import { compareChartQuoteRecency } from "./live-quotes";
import { marketSeriesFrequency } from "./market";
import { canonicalExchange, resolveExchangeTimeZone } from "../utils/exchanges";
import { futuresGenericCaption, futuresGenericListing, futuresListingPriceBasis } from "../utils/futures-generic";
import { contractPriceUnit, currencyPairPriceUnit } from "./price-units";
import { INDEX_POINTS_UNIT, isIndexLevel } from "../market-data/market/index-level";
import { isOhlcSeriesStyle } from "./spec";
import { SERIES_COLORS } from "../theme/series-colors";
import type {
  ChartSeriesSpec,
  ChartSpec,
  ResolvedSeries,
} from "./types";
import { instrumentLabel } from "./resolve-context";
import { finiteDate } from "./chart-bounds";

// A series that fails to load keeps its place with no observations. Dropping it
// made a series the user had added disappear from the legend while it still sat
// in the series editor, with nothing on screen to explain the difference.
export function unloadableSeries(spec: ChartSeriesSpec, index: number, warning: string): ResolvedSeries {
  const field = spec.source.kind === "security" ? getTimeSeriesField(spec.source.fieldId) : undefined;
  const label = spec.source.kind === "security"
    ? `${instrumentLabel(spec.source)} ${field?.seriesLabel ?? field?.shortLabel ?? spec.source.fieldId.split(".").at(-1) ?? "Series"}`
    : spec.source.kind === "economic"
      ? `FRED ${spec.source.seriesId}`
      : spec.source.seriesId;
  return {
    id: spec.id,
    label: spec.label?.trim() || label,
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit: field?.unit ?? "",
    unitGroup: field?.unitGroup ?? "unknown",
    nativeFrequency: field?.nativeFrequency ?? "daily",
    dataShape: field?.dataShape ?? "scalar",
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    warning,
    points: [],
  };
}

export function emptyFinancials(priceHistory: TickerFinancials["priceHistory"] = []): TickerFinancials {
  return { annualStatements: [], quarterlyStatements: [], priceHistory };
}

export function chartCalculationSeriesIds(spec: ChartSpec): Set<string> {
  const ids = activeStudyInputSeriesIds(spec.studies);
  spec.series.filter(entry => entry.visible !== false).forEach(entry => ids.add(entry.id));
  // Hidden primary market data still owns the shared session anchor.
  const primary = spec.series.find(entry => entry.source.kind === "security" && isMarketFieldId(entry.source.fieldId));
  if (primary) ids.add(primary.id);
  return ids;
}

export function latestQuote(snapshot: Quote | undefined, override: Quote | undefined): Quote | undefined {
  if (!snapshot) return override;
  if (!override) return snapshot;
  return compareChartQuoteRecency(override, snapshot) >= 0 ? override : snapshot;
}

export function mergeHistory(
  financials: TickerFinancials | null,
  history: TickerFinancials["priceHistory"],
  quoteOverride: Quote | undefined,
  now: number,
  liveBarResolution?: ManualChartResolution,
  exchange?: string,
  appendQuote = true,
  assetCategory?: string,
  live?: { bars: LiveBarAccumulator; since?: number; session?: HistorySession; extendedHours?: boolean },
): TickerFinancials {
  const base = financials ?? emptyFinancials();
  const quote = latestQuote(base.quote, quoteOverride);
  const unknownHistoryBasis = hasUnknownBondHistoryBasis(quote, assetCategory, base.quoteMetadata?.instrumentType);
  if (!appendQuote || unknownHistoryBasis) return { ...base, quote, priceHistory: history };
  // Market bars fold every observed quote into the forming bar; other series
  // price their latest point from the current quote alone.
  const priceHistory = live && liveBarResolution
    ? live.bars.apply(history, quote, { now, resolution: liveBarResolution, exchange, liveSince: live.since, session: live.session,
      extendedHours: live.extendedHours })
    : appendLiveQuotePoint(history, quote, liveBarResolution
      ? { now, mode: "ohlc", resolution: liveBarResolution, exchange }
      : { now });
  return { ...base, quote, priceHistory };
}

export function baseSecuritySeries(
  spec: ChartSeriesSpec,
  financials: TickerFinancials,
  index: number,
  marketResolution?: ManualChartResolution | null,
  quoteMetadata: QuoteMetadata | null | undefined = financials.quoteMetadata,
  /** What a futures contract's price counts ("USD / gallon"), from its terms. */
  contractUnit?: string | null,
): ResolvedSeries | null {
  if (spec.source.kind !== "security") return null;
  const field = getTimeSeriesField(spec.source.fieldId);
  if (!field) return null;
  const points = extractSecuritySeries(financials, spec.source);
  const valuationFallback = dailyValuationFallbackPeriod(financials, spec.source);
  const unreportedPeriod = points.length === 0 ? unreportedStatementPeriod(financials, spec.source) : null;
  const symbol = instrumentLabel(spec.source);
  const statementCurrency = field.id.startsWith("fundamental.") && field.unit.startsWith("currency")
    ? reportingCurrencySeries(points, financials.financialCurrency) : null;
  // A broker contract names its currency even before (or without) a quote.
  const currency = statementCurrency ? statementCurrency.currency : financials.quote?.currency || quoteMetadata?.currency || spec.source.instrument.instrument?.currency;
  const assetKind = resolveAssetDisplayKind({ assetCategory: financials.quote?.instrumentType || quoteMetadata?.instrumentType });
  const unknownBondBasis = hasUnknownBondHistoryBasis(financials.quote,
    spec.source.instrument.instrument?.secType, quoteMetadata?.instrumentType);
  const volumeUnit = unknownBondBasis ? undefined : assetKind === "equity" ? "shares" as const : assetKind === "contract" ? "contracts" as const : undefined;
  // A price quote establishes its currency, but only instrument metadata can
  // establish a per-share or per-crypto-unit basis. This does not establish the
  // provider's volume denomination or a derivative's contract multiplier.
  const unitTemplate = field.unitGroup === "price" && isMarketFieldId(field.id)
    ? unknownBondBasis ? "unknown" : `currency${assetKind === "equity" ? "/share" : assetKind === "crypto" ? "/unit" : ""}`
    : field.unit;
  const generic = field.unitGroup === "price"
    ? futuresGenericListing(spec.source.instrument.symbol, spec.source.instrument.exchange) : null;
  // A generic future on an index, VIX or Treasuries reads in points or 32nds, and an index
  // future's continuous symbol or contract in points, not dollars, as its quote does.
  const genericBasis = field.unitGroup === "price" && isMarketFieldId(field.id)
    ? futuresListingPriceBasis(spec.source.instrument.symbol, spec.source.instrument.exchange) : null;
  // An index's level is points too, never the currency its members trade in.
  const indexLevel = field.unitGroup === "price" && isMarketFieldId(field.id)
    && isIndexLevel(financials.quote?.instrumentType || quoteMetadata?.instrumentType);
  const genericUnit = genericBasis === "points" || indexLevel ? INDEX_POINTS_UNIT : genericBasis === "thirty-seconds" ? "32nds" : null;
  // A future's price in a currency counts what its contract terms say: heating
  // oil is USD / gallon and crude USD / barrel, which a bare USD does not tell apart.
  const statedUnit = !genericUnit && unitTemplate === "currency" ? contractPriceUnit(contractUnit, currency) : null;
  // A currency pair's rate is the quote currency one unit of the base buys:
  // EURUSD=X is USD / EUR, so Brent over it reads EUR / barrel.
  const pairUnit = !genericUnit && unitTemplate === "currency" && field.unitGroup === "price" && isMarketFieldId(field.id)
    ? currencyPairPriceUnit(spec.source.instrument.symbol, spec.source.instrument.exchange, currency) : null;
  const unit = field.id === "market.volume" ? volumeUnit ?? ""
    : statedUnit ?? genericUnit ?? pairUnit
      ?? (unitTemplate.startsWith("currency") && currency ? unitTemplate.replace("currency", currency) : unitTemplate);
  const currencyUnitGroup = genericUnit ? `${field.unitGroup}:${genericUnit}`
    : unknownBondBasis && field.unitGroup === "price" ? "price:unknown"
    : field.unit.startsWith("currency") && currency
    ? `${field.unitGroup}:${currency}`
    : field.unitGroup;
  const marketExchange = spec.source.instrument.exchange
    || financials.quote?.listingExchangeName
    || financials.quote?.exchangeName;
  const marketField = isMarketFieldId(spec.source.fieldId);
  // A routing code such as a broker's SMART names no venue. The quote's
  // listing then supplies the session clock, so closed hours stay off the axis.
  const sessionExchange = [marketExchange, financials.quote?.listingExchangeName, quoteMetadata?.listingExchangeName, financials.quote?.exchangeName]
    .find((value) => resolveExchangeTimeZone(value));
  // A dollar listing saved with IBKR's SMART route and no other venue trades on
  // the US session, and so does a dollar option, which names no venue at all.
  const dollars = !currency || currency === "USD";
  const usOption = dollars && (spec.source.instrument.instrument?.secType?.toUpperCase() === "OPT"
    || /^OPTION$/i.test(financials.quote?.instrumentType ?? quoteMetadata?.instrumentType ?? ""));
  const routedUsListing = !sessionExchange && ((canonicalExchange(marketExchange) === "SMART" && dollars) || usOption);
  const marketTimeZone = marketField
    && canonicalExchange(marketExchange) !== "CCC"
    ? resolveExchangeTimeZone(sessionExchange) ?? (routedUsListing ? "America/New_York" : null)
    : null;
  // A route has no hours of its own: its sessions, which the day view and
  // VWAP follow, are the venue's, and NYSE's for an unnamed dollar listing.
  const listingExchange = canonicalExchange(marketExchange) === "SMART" || usOption
    ? canonicalExchange(sessionExchange) || (routedUsListing ? "NYSE" : marketExchange)
    : marketExchange;
  const latestChangePercent = marketField && field.unit.startsWith("currency")
    && !unknownBondBasis
    && financials.quote && hasValidQuoteObservationTime(financials.quote)
    ? financials.quote.changePercent
    : undefined;
  const priceIssues = valuationPriceIssues(financials, spec.source);
  // A source with closes only, such as a generic future, has flat bars (open,
  // high and low filled from the close): nothing to draw as candles.
  const closesOnly = marketField && points.length > 1
    && points.every((point) => [point.open, point.high, point.low].every((value) => value == null || value === point.close));
  return {
    id: spec.id,
    label: spec.label?.trim() || (generic ? futuresGenericCaption(generic) : `${symbol} ${field.seriesLabel ?? field.shortLabel}`),
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit,
    unitGroup: currencyUnitGroup,
    ...(statedUnit ? { statedUnit } : {}),
    priceAssetCategory: marketField && field.unitGroup === "price" && !unknownBondBasis
      ? financials.quote?.instrumentType || quoteMetadata?.instrumentType : undefined,
    volumeUnit,
    ...(priceIssues.length ? { valuationPriceIssues: priceIssues } : {}),
    warning: [valuationFallback ? "Release dates unavailable; showing reported periods." : undefined,
      field.id === "market.volume" && !volumeUnit && points.length > 0
        ? "Volume unit unknown." : statementCurrency?.warning ?? valuationCurrencyWarning(financials, spec.source)].filter(Boolean).join(" ") || undefined,
    nativeFrequency: marketField ? marketSeriesFrequency(spec.source, marketResolution)
      : valuationFallback ?? (spec.source.period && spec.source.period !== "auto" ? spec.source.period : field.nativeFrequency),
    ...(unreportedPeriod ? { unreportedPeriod } : {}),
    ...(marketField ? { historyResolution: marketResolution } : {}),
    timestampMode: spec.source.timestampMode,
    dataShape: field.dataShape,
    style: closesOnly && isOhlcSeriesStyle(spec.style ?? field.defaultStyle) ? "line" : spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    observationKind: marketField ? "market" : undefined,
    ...(marketField ? { listing: { symbol: spec.source.instrument.symbol, exchange: listingExchange ?? "" } } : {}),
    timeBasis: marketTimeZone
      ? {
          kind: "market",
          timeZone: marketTimeZone,
          exchange: canonicalExchange(sessionExchange) || undefined,
          cadenceMs: marketResolution
            ? CHART_RESOLUTION_STEP_MS[marketResolution]
            : undefined,
        }
      : undefined,
    latestChangePercent: typeof latestChangePercent === "number" && Number.isFinite(latestChangePercent)
      ? latestChangePercent
      : undefined,
    points,
  };
}

const FRED_CATALOG_UNITS: Readonly<Record<string, string>> = {
  "percent": "%",
  "millions of u.s. dollars": "million USD",
  "millions of dollars": "million USD",
  "billions of dollars": "billion USD",
  "billions of u.s. dollars": "billion USD",
  "billions of us dollars": "billion USD",
  "dollars per barrel": "USD/barrel",
  "thousands of persons": "thousand people",
};

function fredCatalogUnit(units: string): string {
  return FRED_CATALOG_UNITS[units.toLowerCase()] ?? units;
}

export function baseEconomicSeries(
  spec: ChartSeriesSpec,
  loaded: FredSeriesLoadResult,
  index: number,
): ResolvedSeries | null {
  if (spec.source.kind !== "economic") return null;
  const { data } = loaded;
  const units = data.info?.units?.trim() || "value";
  const catalogUnit = fredCatalogUnit(units);
  // "Percent Change from Year Ago" and "Percent per Annum" are percent too.
  const isPercent = units.toLowerCase().includes("percent");
  return {
    id: spec.id,
    label: spec.label?.trim() || data.info?.title?.trim() || spec.source.seriesId,
    color: spec.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    unit: isPercent ? "%" : catalogUnit,
    unitGroup: isPercent ? "percent" : `economic:${catalogUnit.toLowerCase()}`,
    nativeFrequency: "auto",
    timestampMode: "period-end",
    dataShape: "scalar",
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : "left",
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    points: extractFredSeries(data.observations, { providerId: "fred", timestampMode: "period-end" }),
    warning: "FRED vintage dates are unavailable; observations use period dates.",
  };
}

export function baseCapabilitySeries(
  spec: ChartSeriesSpec,
  loaded: ResolvedSeries,
  index: number,
): ResolvedSeries {
  const points = loaded.points.flatMap((point) => {
    const date = finiteDate(point.date as unknown as string | Date | undefined);
    const observedAt = finiteDate(point.observedAt as unknown as string | Date | undefined) ?? date;
    const availableAt = finiteDate(point.availableAt as unknown as string | Date | undefined) ?? undefined;
    return date && observedAt ? [{ ...point, date, observedAt, ...(availableAt ? { availableAt } : {}) }] : [];
  });
  return {
    ...loaded,
    id: spec.id,
    label: spec.label?.trim() || loaded.label || (spec.source.kind === "capability" ? spec.source.seriesId : spec.id),
    color: spec.color ?? loaded.color ?? SERIES_COLORS[index % SERIES_COLORS.length]!,
    style: spec.style,
    transform: spec.transform,
    axis: spec.axis === "right" ? "right" : spec.axis === "left" ? "left" : loaded.axis,
    panelId: spec.panelId,
    interpolation: spec.interpolation,
    observationKind: loaded.observationKind ?? "dataset",
    points,
  };
}

export function staleFredWarning(loaded: FredSeriesLoadResult): string | null {
  if (!loaded.stale) return null;
  return `FRED refresh failed${loaded.refreshError ? ` (${loaded.refreshError})` : ""}; showing cached data fetched ${new Date(loaded.fetchedAt).toISOString().slice(0, 10)}.`;
}
