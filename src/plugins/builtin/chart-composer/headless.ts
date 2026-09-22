import { financialPeriodCoverage } from "../../../time-series/financial-period-coverage";
import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../../../utils/financial-statements";
import { graphRowsForFinancials, summarizeResolvedSeries } from "../../../time-series/reporting";
import { priceHistoryIntegrityNotices, chartPriceHistoryIntegrityNotices } from "../../../time-series/market";
import type { HeadlessPaneContext, HeadlessPaneDefinition, HeadlessSeriesResult } from "../../../types/headless";
import type { ChartResolutionResult, ChartSeriesSpec, ChartSpec } from "../../../time-series/types";
import { mergePriceHistoryWindows, resolveChartSpecData } from "../../../time-series/resolve";
import { intersectChartResolutionSupport, isIntradayResolution, normalizeChartResolutionSupport, type ManualChartResolution } from "../../../time-series/resolution";
import { intradaySessionDates, loadIntradayWindow, resolveIntradayRequest, type IntradayRequest, type IntradayWindow, type LoadedIntradayWindow } from "../../../time-series/session-history";
import { createSnapshotDataProvider, snapshotInstrumentKey, type SnapshotMarketData } from "../../../market-data/snapshot-provider";
import type { InstrumentRef } from "../../../market-data/request-types";
import type { TickerFinancials, PricePoint } from "../../../types/financials";
import { createChartSeriesResolver } from "../../../capabilities";
import { parsePublicTickerKey, publicTickerKey, resolveExchangeTimeZone } from "../../../utils/exchanges";
import { parseChartSpec } from "./chart-spec";
import { paneSchemas } from "./headless-schema";

export interface ChartPaneModel extends HeadlessSeriesResult {
  /** The renderer consumes the full model; generic reports project series and metadata. */
  chart: ChartResolutionResult;
  spec: ChartSpec;
  snapshot: {
    financials: Array<[string, TickerFinancials]>;
    instrumentFinancials?: SnapshotMarketData["instrumentFinancials"];
    historyVariants?: SnapshotMarketData["historyVariants"];
    intradayHistories: Array<IntradayWindow & Pick<LoadedIntradayWindow, "quote" | "priceDomainFailure"> & {
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

export async function loadChartPaneModel(
  spec: ChartSpec,
  context: HeadlessPaneContext,
): Promise<ChartPaneModel> {
  const financials = new Map<string, TickerFinancials>();
  type CapturedHistory = { resolution: ManualChartResolution | null | undefined; requestKey?: string; points: PricePoint[] };
  const histories = new Map<string, Map<string, CapturedHistory>>();
  const primaryHistories = new Map<string, { key: string; rank: number }>();
  const instruments = new Map<string, InstrumentRef>();
  const resolvedSeries = new Map<string, ChartSeriesSpec>();
  const chart = await resolveChartSpecData(spec, {
    dataProvider: context.marketData,
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
        const variantKey = JSON.stringify([resolution === undefined ? "legacy" : resolution, resolution === null ? requestKey ?? null : null]);
        const previous = variants.get(variantKey);
        // Opaque defaults can change cadence between acquisitions. Preserve
        // one acquired array; only compatible known bars can be accumulated.
        variants.set(variantKey, { resolution, requestKey,
          points: resolution === null ? previous?.points ?? data.priceHistory
            : mergePriceHistoryWindows(previous?.points ?? [], data.priceHistory, resolution ?? "1m") });
        histories.set(key, variants);
        const rank = spec.series.findIndex(entry => entry.id === series.id)
          + (source.fieldId.startsWith("market.") ? 0 : spec.series.length);
        const primary = primaryHistories.get(key);
        if (!primary || rank < primary.rank) primaryHistories.set(key, { key: variantKey, rank });
      }
    },
    ...(context.capabilities ? { resolveCapabilitySeries: createChartSeriesResolver(context.capabilities) } : {}),
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
    return history ? { ...data, priceHistory: history.points, priceHistoryResolution: history.resolution, priceHistoryRequestKey: history.requestKey } : data;
  };
  const historyVariants = [...histories].flatMap(([key, variants]) => variants.size > 1
    ? [...variants.values()].flatMap(({ resolution, requestKey, points }) => resolution === undefined ? [] : [{ target: instruments.get(key)!, resolution, requestKey, points }]) : []);
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
    series: chart.series.map((series) => {
      const source = spec.series.find((entry) => entry.id === series.id)?.source;
      const kind = source?.kind === "security" && source.fieldId.startsWith("fundamental.") ? "fundamental"
        : source?.kind === "security" && source.fieldId.startsWith("valuation.") ? "valuation" : null;
      const growth = kind && source?.kind === "security" ? new Map(graphRowsForFinancials(
        financials.get(snapshotInstrumentKey(source.instrument)) ?? null,
        kind, source.fieldId.split(".")[1]!, source.period === "quarterly" ? "quarterly" : "annual",
        source.instrument.symbol,
      ).map((row) => [row.date, row.growth])) : null;
      return {
        ...series,
        derived: !ids.has(series.id),
        points: series.points.map((point) => ({
          ...point,
          ...(growth ? { growth: growth.get(point.periodLabel === "Current" ? "Current" : point.observedAt.toISOString().slice(0, 10)) ?? null } : {}),
        })),
      };
    }),
    errors: chart.errors,
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
      notices: [...chart.warnings.filter((warning) => warning === FINANCIAL_VINTAGE_NOTICE || warning === SEC_EPS_BASIS_NOTICE || warning === chart.priceComparison?.notice), ...integrityNotices],
      priceComparison: chart.priceComparison ?? null,
      summaries: chart.series.map((series) => ({ id: series.id, ...summarizeResolvedSeries(series) })),
    },
  };
}

export function chartHeadless(template: keyof typeof paneSchemas): HeadlessPaneDefinition<"series"> {
  return {
    ...paneSchemas[template],
    shape: "series",
    async load(args, context) {
      const intradayHistories: ChartPaneModel["snapshot"]["intradayHistories"] = [];
      const parsed = parseChartSpec(context.settings?.chartSpec);
      if (!parsed) throw new Error("The chart specification is invalid.");
      let spec = context.resolveInstrument ? {
        ...parsed,
        series: await Promise.all(parsed.series.map(async (series) => {
          if (series.source.kind !== "security" || series.source.instrument.exchange) return series;
          const instrument = await context.resolveInstrument!(series.source.instrument.symbol);
          return { ...series, source: { ...series.source, instrument: { ...series.source.instrument, ...instrument } } };
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
        intradayHistories.push(...histories.map(({ bufferedPoints: _buffer, ...history }) => history));
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
          intradayHistories: histories.map((history) => ({ ...history, points: history.bufferedPoints })),
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
            target, symbol, exchange, points, start, end,
            rangePreset: spec.viewport.range === "1W" ? "1W" : "1D",
            resolution: historyResolution, requestedSession: null,
            sessionDates: intradaySessionDates(points, resolveExchangeTimeZone(exchange) ?? "UTC"),
            unavailableReason: points.length ? null : model.chart.errors[0] ?? `No intraday price history is available for ${symbol} for the requested window.`,
          });
        }
      }
      model.snapshot.intradayHistories = intradayHistories;
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
