import { financialPeriodCoverage } from "../../../time-series/financial-period-coverage";
import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../../../utils/financial-statements";
import { graphRowsForFinancials, summarizeResolvedSeries } from "../../../time-series/reporting";
import { priceHistoryIntegrityNotices, chartPriceHistoryIntegrityNotices } from "../../../time-series/market";
import type { HeadlessPaneContext, HeadlessPaneDefinition, HeadlessPaneFreshness, HeadlessSeries, HeadlessSeriesResult } from "../../../types/headless";
import type { CapabilitySeriesSource, ChartResolutionResult, ChartSeriesSource, ChartSeriesSpec, ChartSpec, ChartViewportSpec, ResolvedSeries } from "../../../time-series/types";
import { resolveGeoChartSeries } from "../world-venue-map/geo-series";
import { GEO_SERIES_CAPABILITY_ID, parseSeriesExpression } from "./series-expression";
import { resolveChartSpecData } from "../../../time-series/resolve";
import { mergePriceHistoryWindows, priceHistoryAcquisitionIdentity, priceHistoryTailAcquisition } from "../../../time-series/history-acquisition";
import {
  getSupportMaxRange,
  intersectChartResolutionSupport,
  isIntradayResolution,
  normalizeChartResolutionSupport,
  type ManualChartResolution,
} from "../../../time-series/resolution";
import type { ChartResolution } from "../../../time-series/range";
import { intradaySessionDates, intradaySessionTimeZone, loadIntradayWindow, resolveIntradayRequest, type IntradayRequest, type IntradayWindow, type LoadedIntradayWindow } from "./session-history";
import { sessionRangeReport } from "./session-range";
import { createSnapshotDataProvider, snapshotInstrumentKey, type SnapshotMarketData } from "../../../market-data/snapshot-provider";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { HistorySession } from "../../../types/price-history";
import type { TickerFinancials, PricePoint, Quote } from "../../../types/financials";
import { chartQuoteOverrideKeyForTarget, getLiveChartQuoteTargets } from "../../../time-series/live-quotes";
import { createChartSeriesResolver } from "../../../capabilities";
import { loadFuturesContractTerms, loadFuturesPriceUnit } from "../../../market-data/futures-contract";
import { parsePublicTickerKey, publicTickerKey } from "../../../utils/exchanges";
import { parseChartSpec } from "./chart-spec";
import { paneSchemas } from "./headless-schema";
import { barHistoryFreshness, REPORTED_DATA } from "../shared/report-freshness";
import type { BarPeriodToDate } from "../../../market-data/market/bar-period";
import { closedHistoryBarDay, formingHistoryBar } from "../ticker-detail/data-panes/history-bars";
import { inferSeriesFrequency } from "../../../series/csv";
import { isDatasetChart } from "../../../time-series/spec";

export interface ChartPaneModel extends HeadlessSeriesResult {
  /** The renderer consumes the full model; generic reports project series and metadata. */
  chart: ChartResolutionResult;
  spec: ChartSpec;
  snapshot: {
    financials: Array<[string, TickerFinancials]>;
    instrumentFinancials?: SnapshotMarketData["instrumentFinancials"];
    historyVariants?: SnapshotMarketData["historyVariants"];
    intradayHistories: Array<IntradayWindow & Pick<LoadedIntradayWindow, "bufferedPoints" | "quote" | "priceDomainFailure" | "session" | "sourceKey"> & {
      symbol: string;
      exchange: string;
      target?: InstrumentRef;
      rangePreset: IntradayRequest["rangePreset"];
      resolution: IntradayRequest["resolution"];
      requestedSession: string | null;
      unavailableReason: string | null;
    }>;
  };
}

/**
 * Map series read straight from the Cloud client, so a report or screenshot
 * charts them where plugin capability handlers are not running; every other
 * capability series goes through the registry as before.
 */
function headlessCapabilityResolver(context: HeadlessPaneContext) {
  const registry = context.capabilities ? createChartSeriesResolver(context.capabilities) : null;
  return async (source: CapabilitySeriesSource, viewport: ChartViewportSpec, spec: ChartSeriesSpec) => {
    if (source.capabilityId === GEO_SERIES_CAPABILITY_ID) {
      const request = <T,>(path: string, init?: RequestInit) => context.apiClient.geo<T>(path, { ...init, signal: init?.signal ?? context.signal });
      return resolveGeoChartSeries(request, source.seriesId, viewport, context.signal);
    }
    if (!registry) throw new Error(`Chart series capability "${source.capabilityId}" is unavailable. Enable its plugin or provider.`);
    return registry(source, viewport, spec);
  };
}

export async function loadChartPaneModel(
  spec: ChartSpec,
  context: HeadlessPaneContext,
): Promise<ChartPaneModel> {
  const financials = new Map<string, TickerFinancials>();
  type CapturedHistory = { resolution: ManualChartResolution | null | undefined; requestKey?: string; points: PricePoint[]; session?: HistorySession; sourceKey?: string };
  const histories = new Map<string, Map<string, CapturedHistory>>();
  const primaryHistories = new Map<string, { key: string; rank: number }>();
  const instruments = new Map<string, InstrumentRef>();
  const resolvedSeries = new Map<string, ChartSeriesSpec>();
  // The pane extends settled bars with streamed quotes. A report has no
  // stream, so a current window takes the latest quote once instead.
  const quoteOverrides = new Map<string, Quote>();
  const getQuote = context.marketData.getQuote?.bind(context.marketData);
  if (getQuote && !spec.viewport.dateWindow) {
    await Promise.all(getLiveChartQuoteTargets(spec).map(async (target) => {
      const quote = await getQuote(target.symbol, target.exchange ?? "",
        context.refresh ? { ...target.context, cacheMode: "refresh" } : target.context).catch(() => null);
      if (quote) quoteOverrides.set(chartQuoteOverrideKeyForTarget(target), quote);
    }));
  }
  const chart = await resolveChartSpecData(spec, {
    dataProvider: context.marketData,
    quoteOverrides,
    onSecurityData(series, data, includesHistory) {
      const { source } = series;
      if (source.kind !== "security") return;
      resolvedSeries.set(series.id, series);
      const key = snapshotInstrumentKey(source.instrument);
      instruments.set(key, source.instrument);
      const previous = financials.get(key);
      const statements = previous?.statementHistory && !data.statementHistory ? previous : data;
      financials.set(key, {
        ...previous, ...data,
        quote: data.quote ?? previous?.quote,
        fundamentals: data.fundamentals ?? previous?.fundamentals,
        profile: data.profile ?? previous?.profile,
        quoteContributions: data.quoteContributions ?? previous?.quoteContributions,
        annualStatements: statements.annualStatements.length ? statements.annualStatements : previous?.annualStatements ?? [],
        quarterlyStatements: statements.quarterlyStatements.length ? statements.quarterlyStatements : previous?.quarterlyStatements ?? [],
        statementHistory: statements.statementHistory,
      });
      if (includesHistory) {
        const variants = histories.get(key) ?? new Map();
        const resolution = data.priceHistoryResolution;
        const requestKey = data.priceHistoryRequestKey;
        const incoming: CapturedHistory = { resolution, requestKey, points: data.priceHistory,
          session: data.priceHistorySession, sourceKey: data.priceHistorySourceKey };
        const variantKey = JSON.stringify([resolution === undefined ? "legacy" : resolution, resolution === null ? requestKey ?? null : null,
          priceHistoryAcquisitionIdentity(incoming)]);
        const previous = variants.get(variantKey);
        // Opaque defaults can change cadence between acquisitions. Preserve
        // one acquired array; only compatible known bars can be accumulated.
        const tail = priceHistoryTailAcquisition(previous, incoming);
        variants.set(variantKey, { resolution, requestKey, session: tail.session, sourceKey: tail.sourceKey,
          points: resolution === null ? previous?.points ?? data.priceHistory
            : mergePriceHistoryWindows(previous?.points ?? [], data.priceHistory, resolution ?? "1m") });
        histories.set(key, variants);
        const rank = spec.series.findIndex(entry => entry.id === series.id)
          + (source.fieldId.startsWith("market.") ? 0 : spec.series.length);
        const primary = primaryHistories.get(key);
        if (!primary || rank < primary.rank) primaryHistories.set(key, { key: variantKey, rank });
      }
    },
    resolveCapabilitySeries: headlessCapabilityResolver(context),
    loadFuturesPriceUnit: (symbol) => loadFuturesPriceUnit(symbol, (key) => loadFuturesContractTerms(key, context.apiClient)),
    loadFredSeries: async (request) => ({
      data: await context.apiClient.getCloudFredSeries(request.seriesId, {
        startDate: request.startDate,
        sortOrder: request.sortOrder,
      }),
      fetchedAt: Date.now(),
      stale: false,
      source: "network",
    }),
  }, undefined, { awaitResolutionSupport: true });
  spec = { ...spec, series: spec.series.map((series) => resolvedSeries.get(series.id) ?? series) };
  const ids = new Set(spec.series.map((series) => series.id));
  const periodCoverage = financialPeriodCoverage(spec, chart.series);
  const integrityNotices = chart.priceHistoryIntegrity
    ? chartPriceHistoryIntegrityNotices(chart.priceHistoryIntegrity) : priceHistoryIntegrityNotices(chart.series);
  const valuationPriceIssues = chart.series.flatMap((series) => series.valuationPriceIssues?.length
    ? [{ seriesId: series.id, label: series.label, issues: series.valuationPriceIssues }] : []);
  const capturedFinancials = (key: string, data: TickerFinancials): TickerFinancials => {
    const variants = histories.get(key);
    const primary = primaryHistories.get(key);
    const history = primary && variants?.get(primary.key);
    return history ? { ...data, priceHistory: history.points, priceHistoryResolution: history.resolution, priceHistoryRequestKey: history.requestKey,
      priceHistorySession: history.session, priceHistorySourceKey: history.sourceKey } : data;
  };
  // The company a security's series is of, from the quote it was read with, and a study's of one series
  // (its volume) that series'. A series labeled for what it is (FUT:CL is "WTI Crude Oil") names nothing more.
  const seriesCompany = (id: string, depth = 0): string | undefined => {
    const entry = spec.series.find((candidate) => candidate.id === id);
    if (entry) {
      return entry.source.kind === "security" && !entry.label?.trim()
        ? financials.get(snapshotInstrumentKey(entry.source.instrument))?.quote?.name?.trim() || undefined
        : undefined;
    }
    const study = spec.studies.find((candidate) => id === candidate.id || id.startsWith(`${candidate.id}:`));
    return study?.inputSeriesIds.length === 1 && depth < 4 ? seriesCompany(study.inputSeriesIds[0]!, depth + 1) : undefined;
  };
  const historyVariants = [...histories].flatMap(([key, variants]) => variants.size > 1
    ? [...variants.values()].flatMap(({ resolution, requestKey, points, session, sourceKey }) => resolution === undefined ? [] : [{ target: instruments.get(key)!, resolution, requestKey, points, session, sourceKey }]) : []);
  return {
    chart,
    spec,
    ...(periodCoverage.length ? {
      complete: periodCoverage.every((entry) => entry.complete),
      stats: periodCoverage.map((entry) => ({ label: `${entry.label} observations`, value: `${entry.returned}/${entry.requested} ${entry.period}${entry.complete ? "" : " (partial)"}` })),
    } : {}),
    ...(integrityNotices.length || valuationPriceIssues.length ? { complete: false } : {}),
    snapshot: {
      financials: [...financials].filter(([key]) => !instruments.get(key)?.instrument).map(([key, data]) => [
        publicTickerKey(instruments.get(key)!.symbol, instruments.get(key)!.exchange), capturedFinancials(key, data),
      ]),
      instrumentFinancials: [...financials].filter(([key]) => instruments.get(key)?.instrument).map(([key, data]) => ({
        instrument: instruments.get(key)!, financials: capturedFinancials(key, data),
      })),
      ...(historyVariants.length ? { historyVariants } : {}),
      intradayHistories: [],
    },
    symbols: [...new Set(spec.series.flatMap(({ source }) => source.kind === "security"
      ? [publicTickerKey(source.instrument.symbol, source.instrument.exchange)] : []))],
    // A volume profile is drawn over the bars in view; its points are the
    // price's own bars, which a report would mislabel as the profile.
    series: chart.series.filter((series) => !series.profile).map((series) => {
      const source = spec.series.find((entry) => entry.id === series.id)?.source;
      const name = seriesCompany(series.id);
      const kind = source?.kind === "security" && source.fieldId.startsWith("fundamental.") ? "fundamental"
        : source?.kind === "security" && source.fieldId.startsWith("valuation.") ? "valuation" : null;
      const growth = kind && source?.kind === "security" ? new Map(graphRowsForFinancials(
        financials.get(snapshotInstrumentKey(source.instrument)) ?? null,
        kind, source.fieldId.split(".")[1]!, source.period === "quarterly" ? "quarterly" : "annual",
        source.instrument.symbol,
      ).map((row) => [row.date, row.growth])) : null;
      return {
        ...series,
        ...name ? { name } : {},
        derived: !ids.has(series.id),
        points: series.points.map((point) => ({
          ...point,
          ...(growth ? { growth: growth.get(point.periodLabel === "Current" ? "Current" : point.observedAt.toISOString().slice(0, 10)) ?? null } : {}),
        })),
      };
    }),
    // A company with no quarterly figures says so, not that GF does not cover it.
    errors: [...chart.errors, ...chart.series.filter((series) => series.unreportedPeriod && series.points.length === 0)
      .map((series) => `${series.label}: no ${series.unreportedPeriod} figures are reported; use --period annual.`)],
    unavailableSymbols: spec.series.filter((series) => series.visible !== false).flatMap((series) => {
      if (chart.series.some((output) => output.id === series.id && output.points.some((point) => point.value !== null && Number.isFinite(point.value)))) return [];
      const source = series.source;
      return [source.kind === "security"
        ? publicTickerKey(source.instrument.symbol, source.instrument.exchange)
        : source.kind === "economic" ? `FRED:${source.seriesId}`
          : `CAP:${source.capabilityId}:${source.seriesId}`];
    }),
    metadata: {
      viewport: spec.viewport, panels: spec.panels, warnings: chart.warnings,
      ...(chart.priceHistoryIntegrity?.length ? { priceHistoryIntegrity: chart.priceHistoryIntegrity } : {}),
      ...(valuationPriceIssues.length ? { valuationPriceIssues } : {}),
      ...(periodCoverage.length ? { periodCoverage } : {}),
      notices: [...chart.warnings.filter((warning) => warning === FINANCIAL_VINTAGE_NOTICE || warning === SEC_EPS_BASIS_NOTICE || warning === chart.priceComparison?.notice
        || chart.delistings?.some((delisting) => delisting.notice === warning)), ...integrityNotices],
      priceComparison: chart.priceComparison ?? null,
      summaries: chart.series.filter((series) => !series.profile).map((series) => ({ id: series.id, ...summarizeResolvedSeries(series) })),
    },
  };
}

const DAY_MS = 24 * 60 * 60_000;
const PERIOD_MONTHS = { monthly: 1, quarterly: 3, annual: 12 } as const;
type Periodicity = keyof typeof PERIOD_MONTHS;

/**
 * The period a series of period dates publishes in, from the spacing of its
 * dates, when its newest date starts one (FRED dates August's CPI 1 Aug).
 */
function seriesPeriodicity(dates: readonly Date[]): Periodicity | null {
  const frequency = inferSeriesFrequency(dates.map((date) => ({ date, value: 0 })));
  if (frequency !== "monthly" && frequency !== "quarterly" && frequency !== "annual") return null;
  const newest = dates.reduce((latest, date) => (date > latest ? date : latest));
  return newest.getUTCDate() === 1 && newest.getUTCMonth() % PERIOD_MONTHS[frequency] === 0 ? frequency : null;
}

/**
 * The dates of a chart of economic and catalog series whose observations are
 * days or periods, never instants (FRED's series, a plugin's daily closes): it
 * is dated by the day of its newest observation, with the oldest series'
 * newest when they end apart, and by the period when every series publishes
 * in the same one: `Aug 2026 (monthly)`, not `Sat 1 Aug 2026 00:00 UTC`.
 * Nothing for a chart with a price series or a series observed at a time of day.
 */
export function periodChartDates(series: readonly HeadlessSeries[], spec: Pick<ChartSpec, "series">): Pick<HeadlessPaneFreshness, "asOf" | "oldest" | "periodicity"> {
  if (!spec.series.length || spec.series.some(({ source }) => source.kind !== "economic" && source.kind !== "capability")) return {};
  const ends: string[] = [];
  const periods = new Set<Periodicity | null>();
  for (const entry of series) {
    const dates = entry.points.flatMap((point) => (point.value ?? point.close) == null ? [] : [new Date(point.date)]);
    if (!dates.length) continue;
    // A date at midnight UTC is a day; anything else is an observation time and keeps it.
    if (dates.some((date) => !Number.isFinite(date.getTime()) || date.getTime() % DAY_MS !== 0)) return {};
    ends.push(dates.reduce((latest, date) => (date > latest ? date : latest)).toISOString().slice(0, 10));
    periods.add(seriesPeriodicity(dates));
  }
  if (!ends.length) return {};
  ends.sort();
  const [periodicity] = periods.size === 1 ? [...periods] : [null];
  return {
    asOf: ends.at(-1)!,
    ...(ends[0] !== ends.at(-1) ? { oldest: ends[0]! } : {}),
    ...(periodicity ? { periodicity } : {}),
  };
}

/**
 * Who a chart cites when each of its series names its own dataset (CBR's
 * policy rates: `FRED series ECBDFR`); nothing, so Gloom Cloud, otherwise.
 */
function seriesAttribution(series: readonly HeadlessSeries[]): Pick<HeadlessPaneFreshness, "source" | "publisher"> {
  const cited = series.map((entry) => (entry as HeadlessSeries & Pick<ResolvedSeries, "attribution">).attribution);
  if (!cited.length || cited.some((attribution) => !attribution)) return {};
  const publishers = [...new Set(cited.map((attribution) => attribution!.publisher))];
  return {
    source: [...new Set(cited.map((attribution) => attribution!.source))].join(", "),
    ...(publishers.every(Boolean) ? { publisher: publishers.join(", ") } : {}),
  };
}

/**
 * Price series are bar histories, stale once bars of the coarsest size stop
 * arriving; fundamentals, valuations and economic series are reported data,
 * economic and catalog series dated by their days or periods (`periodChartDates`). A chart of
 * capability series alone (CHOKE's vessel transits) is a dataset, dated by its
 * newest observation and how far behind that is.
 */
function chartFreshness(series: readonly HeadlessSeries[], spec: ChartSpec): HeadlessPaneFreshness {
  const order = ["1wk", "1mo"];
  const resolutions = series.map((entry) => (entry as HeadlessSeries & { historyResolution?: string }).historyResolution);
  const dataset = isDatasetChart(spec);
  if (!series.length || resolutions.some((resolution) => !resolution)) {
    return { ...REPORTED_DATA, basis: "reported and published data", ...(dataset ? { dataset } : {}), ...periodChartDates(series, spec), ...seriesAttribution(series) };
  }
  const coarsest = resolutions.reduce((worst, resolution) => (
    order.indexOf(resolution!) > order.indexOf(worst!) ? resolution : worst
  ), resolutions[0]);
  const forming = formingPriceBar(series);
  // A history: its first bars are not stale data, so the line dates it by the bar still forming alone.
  if (forming) return { ...barHistoryFreshness(coarsest), periodToDate: forming, oldest: null };
  const closedDay = closedPriceBarDay(series);
  return { ...barHistoryFreshness(coarsest), ...(closedDay ? { asOf: closedDay } : {}) };
}

/** A series' venue and the day its newest bar starts, as the forming and closed bar checks read them. */
function newestBar(entry: HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis" | "listing">>): { day: string; venue: string | undefined } | null {
  const last = entry.points.at(-1);
  const time = last ? new Date(last.date).getTime() : Number.NaN;
  if (!entry.historyResolution || !Number.isFinite(time)) return null;
  return { day: new Date(time).toISOString().slice(0, 10), venue: entry.timeBasis?.exchange || entry.listing?.exchange || undefined };
}

/**
 * The day the newest complete weekly or monthly bar of the chart closed on,
 * the latest across its series: a week of bars dated Mon 12 Oct 2026 is dated
 * Fri 16 Oct, the day their closes are from. Null for daily and intraday bars.
 */
function closedPriceBarDay(series: readonly HeadlessSeries[]): string | null {
  const days = (series as ReadonlyArray<HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis" | "listing">>>).flatMap((entry) => {
    const bar = newestBar(entry);
    const day = bar ? closedHistoryBarDay(entry.historyResolution!, bar.day, bar.venue, Date.now()) : null;
    return day ? [day] : [];
  });
  return days.length ? days.sort().at(-1)! : null;
}

/**
 * The first series whose newest weekly or monthly bar is a week or month that
 * had not ended, as `history` and HP date it: the report is then dated by how
 * far that bar runs (`month to date, through Fri 16 Oct 2026`), not by the
 * first day of the period the bar is dated by.
 */
function formingPriceBar(series: readonly HeadlessSeries[]): BarPeriodToDate | null {
  for (const entry of series as ReadonlyArray<HeadlessSeries & Partial<Pick<ResolvedSeries, "historyResolution" | "timeBasis" | "listing">>>) {
    const bar = newestBar(entry);
    const forming = bar ? formingHistoryBar(entry.historyResolution!, bar.day, bar.venue, Date.now()) : null;
    if (forming) return forming;
  }
  return null;
}

/** What a chart series was asked as: a listing as typed (`USDZAR=X`, `SAN:EPA`), a FRED series by its ID. */
function askedSymbol(source: ChartSeriesSource): string {
  switch (source.kind) {
    case "security": return publicTickerKey(source.instrument.symbol, source.instrument.exchange || undefined);
    case "economic": return source.seriesId.toUpperCase();
    case "capability": return `CAP:${source.capabilityId}:${source.seriesId}`;
  }
}

/**
 * The bars a market series was served in (`1mo`), else how often the series
 * observes (`quarterly`), else how far apart its points are (a FRED series
 * charts at its own frequency, `daily` for DEXSFUS).
 */
function servedInterval(series: Pick<ResolvedSeries, "historyResolution" | "nativeFrequency"> & Pick<HeadlessSeries, "points">): string | undefined {
  if (series.historyResolution) return series.historyResolution;
  if (series.nativeFrequency && series.nativeFrequency !== "auto") return series.nativeFrequency;
  const spacing = inferSeriesFrequency(series.points.map((point) => ({ date: point.date, value: 0 })));
  return spacing === "irregular" ? undefined : spacing;
}

/** A dropped resolution, as JSON's `metadata.resolution` states it. */
export interface ChartResolutionDrop {
  requested: ManualChartResolution;
  returned: ManualChartResolution;
  range: string;
  reason: string;
}

/**
 * A bar size asked for that the chart's price series did not come back in:
 * what was asked, what was returned and why, so a report never hands back
 * monthly bars for `--chartResolution 1d` without saying so. Null when every
 * price series is in the bars asked for, or none was asked.
 */
export function chartResolutionDrop(
  requested: ChartResolution,
  viewport: Pick<ChartViewportSpec, "range" | "dateWindow">,
  series: ReadonlyArray<Pick<ResolvedSeries, "historyResolution"> & { symbol?: string }>,
  support: ChartResolutionResult["resolutionSupport"],
): { drop: ChartResolutionDrop; warning: string } | null {
  if (requested === "auto") return null;
  const dropped = series.filter((entry) => entry.historyResolution && entry.historyResolution !== requested);
  const returned = dropped[0]?.historyResolution;
  if (!returned) return null;
  const range = viewport.dateWindow ? "this window" : viewport.range;
  const symbols = [...new Set(dropped.flatMap((entry) => entry.symbol ? [entry.symbol] : []))];
  const maxRange = support?.length ? getSupportMaxRange(support, requested) : null;
  const reason = !support?.length ? `the source returned ${returned} bars`
    : maxRange == null ? `the source does not serve ${requested} bars`
      : `${requested} bars go back ${maxRange} at most`;
  const on = symbols.length > 0 ? ` on ${symbols.join(" and ")}` : "";
  return {
    drop: { requested, returned, range, reason },
    warning: `${requested} is not available for ${range}${on} (${reason}); returning ${returned} bars.`,
  };
}

/**
 * The chart's argument with a bare symbol's series on one listing: `BDI` with
 * BDI:TSX is `BDI:TSX`, `BDI:volume, AAPL` is `BDI:TSX:volume, AAPL`. The
 * listing alone when the argument does not name the symbol as a series.
 */
export function argumentWithListing(argument: string, symbol: string, key: string): string {
  let named = false;
  const legs = argument.split(/([;,\n]\s*)/).map((leg, index) => {
    if (index % 2 === 1) return leg;
    const parsed = parseSeriesExpression(leg);
    const typed = /^(\s*)([^:\s]+)(.*)$/s.exec(leg);
    if (parsed?.kind !== "security" || parsed.exchange || !typed || typed[2]!.toUpperCase() !== symbol.toUpperCase()) return leg;
    named = true;
    return `${typed[1]}${key}${typed[3]}`;
  });
  return named ? legs.join("") : key;
}

export function chartHeadless(template: keyof typeof paneSchemas): HeadlessPaneDefinition<"series"> {
  return {
    ...paneSchemas[template],
    shape: "series",
    async load(args, context) {
      const intradayHistories: ChartPaneModel["snapshot"]["intradayHistories"] = [];
      const parsed = parseChartSpec(context.settings?.chartSpec);
      if (!parsed) throw new Error("The chart specification is invalid.");
      // A bare symbol is the listing `quote` reads it as: BDI, which two companies list, asks which,
      // as `quote BDI` does, instead of charting whichever line a source picked.
      const reads = new Map<string, ReturnType<typeof readSeriesListing>>();
      const readSeriesListing = async (symbol: string): Promise<{ symbol: string; exchange?: string } | null> => {
        const read = await context.resolveListing?.(symbol, (key) => argumentWithListing(args.rawArgument, symbol, key));
        if (read) return { symbol: read.symbol, ...read.exchange ? { exchange: read.exchange } : {} };
        return context.resolveInstrument ? context.resolveInstrument(symbol) : null;
      };
      let spec = context.resolveInstrument || context.resolveListing ? {
        ...parsed,
        series: await Promise.all(parsed.series.map(async (series) => {
          if (series.source.kind !== "security" || series.source.instrument.exchange) return series;
          const { symbol } = series.source.instrument;
          if (!reads.has(symbol)) reads.set(symbol, readSeriesListing(symbol));
          const instrument = await reads.get(symbol)!;
          return instrument ? { ...series, source: { ...series.source, instrument: { ...series.source.instrument, ...instrument } } } : series;
        })),
      } : parsed;
      if (template === "graph-intraday-price-pane" && !spec.viewport.dateWindow) {
        const instruments = new Map(spec.series.flatMap(({ source }) => source.kind === "security"
          ? [[snapshotInstrumentKey(source.instrument), source.instrument] as const] : []));
        const support = spec.viewport.resolution === "auto" && context.marketData.getChartResolutionSupport
          ? intersectChartResolutionSupport(await Promise.all([...instruments.values()].map(async (target) => (
            normalizeChartResolutionSupport(await Promise.resolve(context.marketData.getChartResolutionSupport!(
              target.symbol, target.exchange ?? "", { brokerId: target.brokerId, brokerInstanceId: target.brokerInstanceId, instrument: target.instrument },
            )).catch(() => []))
          ))))
          : [];
        const request = resolveIntradayRequest({
          rangePreset: spec.viewport.range,
          chartResolution: spec.viewport.resolution,
          session: args.options.session,
          support,
        });
        const histories = await Promise.all([...instruments.values()].map(async (target) => ({
          target, symbol: target.symbol, exchange: target.exchange ?? "", resolution: request.resolution, rangePreset: request.rangePreset, requestedSession: request.session,
          ...await loadIntradayWindow({ provider: context.marketData, symbol: target.symbol, exchange: target.exchange ?? "", request, context: { brokerId: target.brokerId, brokerInstanceId: target.brokerInstanceId, instrument: target.instrument } }),
        })));
        context.signal.throwIfAborted();
        intradayHistories.push(...histories);
        const starts = histories.flatMap(({ start }) => start ? [start.getTime()] : []);
        const ends = histories.flatMap(({ end }) => end ? [end.getTime()] : []);
        spec = { ...spec, viewport: {
          ...spec.viewport, range: request.rangePreset, resolution: request.resolution,
          ...(starts.length && ends.length ? { dateWindow: {
            start: new Date(Math.min(...starts)).toISOString(),
            end: new Date(Math.max(...ends)).toISOString(),
          } } : {}),
        } };
        context = { ...context, marketData: createSnapshotDataProvider({
          financials: [],
          intradayHistories: histories,
        }, context.marketData) };
      }
      const model = await loadChartPaneModel(spec, context);
      if (template === "graph-intraday-price-pane" && !intradayHistories.length && model.chart.viewport) {
        const { start, end } = model.chart.viewport;
        for (const { target, data } of [
          ...model.snapshot.financials.map(([key, data]) => ({ target: { ...parsePublicTickerKey(key), instrument: null } as InstrumentRef, data })),
          ...(model.snapshot.instrumentFinancials ?? []).map(({ instrument, financials }) => ({ target: instrument, data: financials })),
        ]) {
          const historyResolution = data.priceHistoryResolution;
          if (!historyResolution || !isIntradayResolution(historyResolution)) continue;
          const { symbol, exchange = "" } = target;
          const points = data.priceHistory.filter(({ date }) => date >= start && date <= end);
          intradayHistories.push({
            target, symbol, exchange, points, bufferedPoints: data.priceHistory, start, end, session: data.priceHistorySession, sourceKey: data.priceHistorySourceKey,
            ...data.quote ? { quote: data.quote } : {},
            rangePreset: spec.viewport.range === "1W" ? "1W" : "1D",
            resolution: historyResolution, requestedSession: null,
            sessionDates: intradaySessionDates(points, intradaySessionTimeZone(symbol, exchange)),
            unavailableReason: points.length ? null : model.chart.errors[0] ?? `No intraday price history is available for ${symbol} for the requested window.`,
          });
        }
      }
      model.snapshot.intradayHistories = intradayHistories;
      // On a depeg or a crash the question is how low it went and when: each listing's low and high, with their times.
      // Named as the series are: a window read before the listing was settled takes the venue the chart resolved.
      const listingExchange = (symbol: string, exchange: string) => exchange || model.spec.series.flatMap(({ source }) => (
        source.kind === "security" && source.instrument.symbol.toUpperCase() === symbol.toUpperCase() ? [source.instrument.exchange ?? ""] : []
      )).find(Boolean) || "";
      const ranges = sessionRangeReport(intradayHistories.map((window) => ({ ...window, exchange: listingExchange(window.symbol, window.exchange) })));
      if (ranges.entries.length) {
        model.stats = [...model.stats ? Array.isArray(model.stats) ? model.stats : Object.entries(model.stats).map(([label, value]) => ({ label, value })) : [], ...ranges.entries];
        model.metadata = { ...model.metadata, sessionRanges: ranges.ranges };
      }
      // Exports name each series by what it was asked as and the bars or frequency it came back in.
      const asked = new Map(parsed.series.map((series) => [series.id, askedSymbol(series.source)]));
      model.series = model.series.map((series) => {
        const symbol = asked.get(series.id);
        const interval = servedInterval(series as HeadlessSeries & Pick<ResolvedSeries, "historyResolution" | "nativeFrequency">);
        return { ...series, ...(symbol ? { symbol } : {}), ...(interval ? { interval } : {}) };
      });
      const dropped = chartResolutionDrop(
        parsed.viewport.resolution,
        model.spec.viewport,
        (model.series as Array<HeadlessSeries & Pick<ResolvedSeries, "historyResolution"> & { derived?: boolean }>).filter((series) => !series.derived),
        model.chart.resolutionSupport,
      );
      if (dropped) {
        model.warnings = [...model.warnings ?? [], dropped.warning];
        model.metadata = { ...model.metadata, resolution: dropped.drop };
      }
      model.freshness = chartFreshness(model.series, model.spec);
      const priceDomainFailures = intradayHistories.flatMap(({ symbol, exchange, priceDomainFailure }) =>
        priceDomainFailure ? [{ symbol, exchange, ...priceDomainFailure }] : []);
      if (priceDomainFailures.length) {
        model.complete = false;
        model.metadata = { ...model.metadata, intradayPriceDomainFailures: priceDomainFailures };
      }
      for (const { symbol, exchange, target, points, unavailableReason } of intradayHistories) {
        const key = publicTickerKey(symbol, exchange);
        if (target?.instrument) {
          if (!model.snapshot.instrumentFinancials?.some(entry => snapshotInstrumentKey(entry.instrument) === snapshotInstrumentKey(target))) {
            model.snapshot.instrumentFinancials = [...model.snapshot.instrumentFinancials ?? [], { instrument: target, financials: { annualStatements: [], quarterlyStatements: [], priceHistory: points } }];
          }
        } else if (!model.snapshot.financials.some(([candidate]) => candidate === key)) {
          model.snapshot.financials.push([key, { annualStatements: [], quarterlyStatements: [], priceHistory: points }]);
        }
        if (unavailableReason && !model.chart.errors.some((error) => error === unavailableReason || error.endsWith(`: ${unavailableReason}`))) {
          model.chart.errors.push(unavailableReason);
        }
      }
      return model;
    },
  };
}
