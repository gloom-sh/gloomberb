import { financialPeriodCoverage } from "../../../time-series/financial-period-coverage";
import { FINANCIAL_VINTAGE_NOTICE, SEC_EPS_BASIS_NOTICE } from "../../../utils/financial-statements";
import { graphRowsForFinancials, summarizeResolvedSeries } from "../../../time-series/reporting";
import { priceHistoryIntegrityNotices, chartPriceHistoryIntegrityNotices } from "../../../time-series/market";
import type { HeadlessPaneContext, HeadlessPaneDefinition, HeadlessSeriesResult } from "../../../types/headless";
import type { ChartResolutionResult, ChartSeriesSpec, ChartSpec } from "../../../time-series/types";
import { mergePriceHistoryWindows, resolveChartSpecData } from "../../../time-series/resolve";
import { intradaySessionDates, loadIntradayWindow, resolveIntradayRequest, type IntradayRequest, type IntradayWindow, type LoadedIntradayWindow } from "../../../time-series/session-history";
import { createSnapshotDataProvider } from "../../../market-data/snapshot-provider";
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
    intradayHistories: Array<IntradayWindow & Pick<LoadedIntradayWindow, "quote" | "priceDomainFailure"> & {
      symbol: string;
      exchange: string;
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
  const histories = new Map<string, PricePoint[]>();
  const resolvedSeries = new Map<string, ChartSeriesSpec>();
  const chart = await resolveChartSpecData(spec, {
    dataProvider: context.marketData,
    onSecurityData(series, data, includesHistory) {
      const { source } = series;
      if (source.kind !== "security") return;
      resolvedSeries.set(series.id, series);
      const key = publicTickerKey(source.instrument.symbol, source.instrument.exchange);
      const previous = financials.get(key);
      financials.set(key, {
        ...previous, ...data,
        quote: data.quote ?? previous?.quote,
        fundamentals: data.fundamentals ?? previous?.fundamentals,
        profile: data.profile ?? previous?.profile,
        quoteContributions: data.quoteContributions ?? previous?.quoteContributions,
        annualStatements: data.annualStatements.length ? data.annualStatements : previous?.annualStatements ?? [],
        quarterlyStatements: data.quarterlyStatements.length ? data.quarterlyStatements : previous?.quarterlyStatements ?? [],
      });
      if (includesHistory) histories.set(key, mergePriceHistoryWindows(histories.get(key) ?? [], data.priceHistory, "1m"));
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
  });
  spec = { ...spec, series: spec.series.map((series) => resolvedSeries.get(series.id) ?? series) };
  const ids = new Set(spec.series.map((series) => series.id));
  const periodCoverage = financialPeriodCoverage(spec, chart.series);
  const integrityNotices = chart.priceHistoryIntegrity
    ? chartPriceHistoryIntegrityNotices(chart.priceHistoryIntegrity) : priceHistoryIntegrityNotices(chart.series);
  const valuationPriceIssues = chart.series.flatMap((series) => series.valuationPriceIssues?.length
    ? [{ seriesId: series.id, label: series.label, issues: series.valuationPriceIssues }] : []);
  return {
    chart,
    spec,
    ...(periodCoverage.length ? {
      complete: periodCoverage.every((entry) => entry.complete),
      stats: periodCoverage.map((entry) => ({ label: `${entry.label} observations`, value: `${entry.returned}/${entry.requested} ${entry.period}${entry.complete ? "" : " (partial)"}` })),
    } : {}),
    ...(integrityNotices.length || valuationPriceIssues.length ? { complete: false } : {}),
    snapshot: {
      financials: [...financials].map(([key, data]) => [key, { ...data, priceHistory: histories.get(key) ?? data.priceHistory }]),
      intradayHistories: [],
    },
    symbols: [...new Set(spec.series.flatMap(({ source }) => source.kind === "security"
      ? [publicTickerKey(source.instrument.symbol, source.instrument.exchange)] : []))],
    series: chart.series.map((series) => {
      const source = spec.series.find((entry) => entry.id === series.id)?.source;
      const kind = source?.kind === "security" && source.fieldId.startsWith("fundamental.") ? "fundamental"
        : source?.kind === "security" && source.fieldId.startsWith("valuation.") ? "valuation" : null;
      const growth = kind && source?.kind === "security" ? new Map(graphRowsForFinancials(
        financials.get(publicTickerKey(source.instrument.symbol, source.instrument.exchange)) ?? null,
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
        const request = resolveIntradayRequest({
          rangePreset: spec.viewport.range,
          chartResolution: spec.viewport.resolution,
          session: args.options.session,
        });
        const instruments = new Map(spec.series.flatMap(({ source }) => source.kind === "security"
          ? [[publicTickerKey(source.instrument.symbol, source.instrument.exchange), source.instrument] as const] : []));
        const histories = await Promise.all([...instruments.values()].map(async ({ symbol, exchange = "" }) => ({
          symbol, exchange, resolution: request.resolution, rangePreset: request.rangePreset, requestedSession: request.session,
          ...await loadIntradayWindow({ provider: context.marketData, symbol, exchange, request }),
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
        for (const [key, data] of model.snapshot.financials) {
          const { symbol, exchange = "" } = parsePublicTickerKey(key);
          const points = data.priceHistory.filter(({ date }) => date >= start && date <= end);
          intradayHistories.push({
            symbol, exchange, points, start, end,
            rangePreset: spec.viewport.range === "1W" ? "1W" : "1D",
            resolution: model.chart.resolution!, requestedSession: null,
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
      for (const { symbol, exchange, points, unavailableReason } of intradayHistories) {
        const key = publicTickerKey(symbol, exchange);
        if (!model.snapshot.financials.some(([candidate]) => candidate === key)) {
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
