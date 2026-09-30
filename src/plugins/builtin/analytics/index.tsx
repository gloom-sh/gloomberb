import { usePaneSettingValue } from "../../../public/react";
import { PortfolioRiskPane } from "./risk-pane";
import { portfolioRiskHeadless } from "./risk-headless";
import { portfolioRiskCache } from "./risk-client";
import { Box, Text } from "../../../ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  chartTableChromeRows,
  ChartTableHeader,
  EmptyState,
  formatPercentAxis,
  PaneStatusBody,
  scalarPoint,
  staticSeries,
  usePaneNoticeFooter,
  usePaneTabs,
  type ChartTableChart,
} from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors } from "../../../theme/colors";
import { convertCurrency, formatCompactAmount } from "../../../utils/format";
import { nextHeaderSort } from "../../../utils/sort-values";
import {
  getFocusedCollectionId,
  useAppSelector,
  usePaneInstance,
  usePaneStateValue,
  usePaneAppConfig,
} from "../../../state/app/context";
import { useChartQueries, useFxRatesMap } from "../../../market-data/hooks";
import { useLiveTickerFinancialsMap, useSampledValue } from "../../../state/hooks/live-ticker-financials";
import { buildPortfolioFinancialsMap } from "../../../market-data/portfolio-financials";
import { usePortfolioAccountState } from "../portfolio-list/summary/live-accounts";
import { calculatePortfolioSummaryTotals, type ColumnContext } from "../portfolio-list/metrics";
import { accountDailyReturns, buildAccountRiskRows } from "./account-returns";
import {
  buildPerformanceChartPoints,
  performanceHistoryNote,
  resolvePerformanceMetric,
  useBrokerPortfolioPerformance,
} from "./broker-performance";
import {
  computeSharpeRatio,
  hasPortfolioPosition,
} from "./metrics";
import {
  buildAnalyticsRiskRows,
  buildAnalyticsSummaryRows,
  buildBenchmarkReturnSeries,
  buildHistoryAxisLabel,
  buildPortfolioChartTargets,
  buildPortfolioReturnSeries,
  buildPortfolioBetaResult,
  formatHistoryValueAxis,
  PORTFOLIO_BENCHMARK,
  resolvePerformancePalette,
} from "./pane-model";
import {
  buildSectorColumns,
  buildSectorRowsFromPortfolioColumns,
  buildTrackedCurrencies,
  DEFAULT_SECTOR_SORT,
  sortSectorRows,
  type SectorSortPreference,
  type SectorTableColumn,
} from "./sector-model";
import { describePortfolioTab, resolvePortfolioId, resolveTemplatePortfolioId } from "./portfolio-selection";
import {
  analyticsFigures,
  riskFigureNotices,
  SectorAllocationTable,
} from "./view";

const ANALYTICS_STATS_SAMPLE_MS = 5_000;
const unavailableHistory = "Account history unavailable.";

function LegacyPortfolioAnalyticsPane({ focused, width, height }: PaneProps) {
  const focusedCollectionId = useAppSelector((state) => getFocusedCollectionId(state));
  const portfolios = useAppSelector((state) => state.config.portfolios);
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const cachedFinancials = useAppSelector((state) => state.financials);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const config = usePaneAppConfig();
  const paneInstance = usePaneInstance();
  const requestedPortfolioId = paneInstance?.params?.portfolioId ?? paneInstance?.params?.collectionId;
  const fallbackPortfolioId = useMemo(
    () => (
      resolvePortfolioId(portfolios, requestedPortfolioId)
      ?? resolveTemplatePortfolioId(portfolios, focusedCollectionId)
      ?? ""
    ),
    [focusedCollectionId, portfolios, requestedPortfolioId],
  );

  const [currentPortfolioId, setCurrentPortfolioId] = usePaneStateValue<string>("portfolioId", fallbackPortfolioId);
  const [selectedSectorId, setSelectedSectorId] = useState<string | null>(null);
  const [sectorSort, setSectorSort] = useState<SectorSortPreference>(DEFAULT_SECTOR_SORT);

  const activePortfolioId = resolvePortfolioId(portfolios, currentPortfolioId) ?? fallbackPortfolioId;
  const activePortfolio = useMemo(
    () => portfolios.find((portfolio) => portfolio.id === activePortfolioId) ?? null,
    [activePortfolioId, portfolios],
  );
  const portfolioTabs = useMemo(
    () => portfolios.map((portfolio) => ({
      label: describePortfolioTab(portfolio, config.brokerInstances),
      value: portfolio.id,
    })),
    [config.brokerInstances, portfolios],
  );

  const handlePortfolioSelect = useCallback((portfolioId: string) => {
    setCurrentPortfolioId(portfolioId);
    setSelectedSectorId(null);
  }, [setCurrentPortfolioId]);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs(portfolioTabs.length > 0 ? {
    tabs: portfolioTabs,
    activeValue: activePortfolioId,
    onSelect: handlePortfolioSelect,
    focused,
    compact: true,
  } : null);
  const bodyHeight = Math.max(3, height - tabRows);

  const portfolioTickers = useMemo(() => {
    if (!activePortfolioId) return [];
    return [...tickersBySymbol.values()]
      .filter((ticker) => ticker.metadata.portfolios.includes(activePortfolioId))
      .filter((ticker) => hasPortfolioPosition(ticker, activePortfolioId));
  }, [activePortfolioId, tickersBySymbol]);
  const instrumentOptions = useMemo(() => ({
    portfolioId: activePortfolioId || undefined,
  }), [activePortfolioId]);

  const chartTargets = useMemo(
    () => buildPortfolioChartTargets(portfolioTickers, instrumentOptions),
    [portfolioTickers, instrumentOptions],
  );
  const chartRequests = useMemo(
    () => chartTargets.flatMap((target) => target.request ? [target.request] : []),
    [chartTargets],
  );
  const chartEntries = useChartQueries(chartRequests);

  const spyRequest = useMemo(
    () => ({
      instrument: { symbol: PORTFOLIO_BENCHMARK.symbol, exchange: PORTFOLIO_BENCHMARK.exchange },
      bufferRange: "1Y" as const,
      granularity: "range" as const,
    }),
    [],
  );
  const spyChartRequests = useMemo(() => [spyRequest], [spyRequest]);
  const spyChartEntries = useChartQueries(spyChartRequests);

  // Totals and weights are aggregates, so the positions stream as background
  // targets (about once a second each) and merge with the portfolio pane's rows.
  const marketFinancials = useLiveTickerFinancialsMap(portfolioTickers, {
    surface: "portfolio",
    visible: false,
    weight: 20,
    instrumentOptions,
  });
  const financials = useMemo(
    () => buildPortfolioFinancialsMap(portfolioTickers, cachedFinancials, marketFinancials, instrumentOptions),
    [portfolioTickers, cachedFinancials, marketFinancials, instrumentOptions],
  );
  // Sharpe and beta weight daily returns by position value; they are daily
  // statistics and do not need to be recomputed on every tick.
  const statsFinancials = useSampledValue(
    financials,
    ANALYTICS_STATS_SAMPLE_MS,
    `${activePortfolioId}\u001f${[...financials.keys()].join(",")}`,
  );
  const brokerPerformance = useBrokerPortfolioPerformance(activePortfolio, config);
  const performanceChartPoints = useMemo(
    () => buildPerformanceChartPoints(brokerPerformance.performance),
    [brokerPerformance.performance],
  );
  // The broker's own daily returns, when it has them, replace the holdings basket for risk.
  const accountReturns = useMemo(
    () => accountDailyReturns(brokerPerformance.performance),
    [brokerPerformance.performance],
  );
  const accountStateInput = useMemo(() => ({ brokerAccounts, config }), [brokerAccounts, config]);
  const { accountState, accountsError } = usePortfolioAccountState(activePortfolio, accountStateInput);
  const trackedCurrencies = useMemo(
    () => [...buildTrackedCurrencies(portfolioTickers, financials, baseCurrency), accountState?.account.currency],
    [accountState?.account.currency, baseCurrency, financials, portfolioTickers],
  );
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  const columnContext = useMemo<ColumnContext>(() => ({
    activeTab: activePortfolioId || undefined,
    baseCurrency,
    exchangeRates,
    now: Date.now(),
  }), [activePortfolioId, baseCurrency, exchangeRates]);

  const portfolioStats = useMemo(
    () => calculatePortfolioSummaryTotals(
      portfolioTickers,
      financials,
      baseCurrency,
      exchangeRates,
      true,
      activePortfolioId || null,
    ),
    [activePortfolioId, baseCurrency, exchangeRates, financials, portfolioTickers],
  );

  const returnSeriesResult = useMemo(
    () => buildPortfolioReturnSeries({
      chartTargets,
      chartEntries,
      financials: statsFinancials,
      columnContext,
      account: accountState?.account,
    }),
    [accountState, chartEntries, chartTargets, columnContext, statsFinancials],
  );
  const portfolioReturnSeries = returnSeriesResult.returns;

  const portfolioReturns = useMemo(
    () => portfolioReturnSeries?.map((point) => point.value) ?? null,
    [portfolioReturnSeries],
  );

  const spyReturnSeries = useMemo(
    () => buildBenchmarkReturnSeries(spyRequest, spyChartEntries),
    [spyChartEntries, spyRequest],
  );

  const sharpe = useMemo(
    () => (portfolioReturns && returnSeriesResult.sharpeCadence.supported ? computeSharpeRatio(portfolioReturns) : null),
    [portfolioReturns, returnSeriesResult.sharpeCadence],
  );

  const betaResult = useMemo(
    () => buildPortfolioBetaResult(returnSeriesResult, spyReturnSeries),
    [returnSeriesResult, spyReturnSeries],
  );
  const beta = betaResult.value;

  const sectorAllocation = useMemo(
    () => buildSectorRowsFromPortfolioColumns(portfolioTickers, financials, columnContext),
    [columnContext, financials, portfolioTickers],
  );
  const allocationNotices = [
    ...(sectorAllocation.unvaluedSymbols.length > 0 ? [{
      text: `Weights unavailable: missing prices or FX for ${sectorAllocation.unvaluedSymbols.join(", ")}.`, tone: "warning" as const,
    }] : []),
  ];
  const sectorRows = sectorAllocation.rows;
  const sortedSectorRows = useMemo(
    () => sortSectorRows(sectorRows, sectorSort),
    [sectorRows, sectorSort],
  );
  const effectiveSelectedSectorId = selectedSectorId && sortedSectorRows.some((row) => row.id === selectedSectorId)
    ? selectedSectorId
    : sortedSectorRows[0]?.id ?? null;
  const sectorColumns = useMemo(() => buildSectorColumns(width), [width]);
  const hasPositions = portfolioTickers.length > 0;
  const hasAccountContent = accountState != null || brokerPerformance.performance != null
    || brokerPerformance.loading || brokerPerformance.error != null;

  const summaryRows = useMemo(
    () => buildAnalyticsSummaryRows({
      accountState,
      activePortfolio,
      brokerPerformance: brokerPerformance.performance,
      portfolioStats,
      convertAccountValue: (value) => convertCurrency(
        value,
        accountState?.account.currency ?? "",
        baseCurrency,
        exchangeRates,
      ),
    }),
    [accountState, activePortfolio, baseCurrency, brokerPerformance.performance, exchangeRates, portfolioStats],
  );

  const riskRows = useMemo(
    () => !hasPositions ? [] : accountReturns ? buildAccountRiskRows({
      returns: accountReturns,
      benchmarkReturns: spyReturnSeries.returns,
      benchmarkIntegrity: spyReturnSeries.integrity,
    }) : buildAnalyticsRiskRows({
      sharpe,
      beta,
      coverage: returnSeriesResult.coverage,
      missingCount: returnSeriesResult.missingCount,
      unvaluedCount: returnSeriesResult.unvaluedCount,
      unsupportedReason: returnSeriesResult.unsupportedReason,
      historyIntegrity: returnSeriesResult.historyIntegrity,
      benchmarkIntegrity: spyReturnSeries.integrity,
      sharpeCadence: returnSeriesResult.sharpeCadence,
      returnTimestamps: returnSeriesResult.returnTimestamps,
      betaHoldingTimestamps: betaResult.holdingTimestamps,
      benchmarkTimestamps: betaResult.benchmarkTimestamps,
      returns: portfolioReturnSeries,
      benchmarkReturns: spyReturnSeries.returns,
    }),
    [accountReturns, beta, betaResult, hasPositions, returnSeriesResult, spyReturnSeries, sharpe],
  );
  const figures = useMemo(() => analyticsFigures(summaryRows, riskRows, width), [riskRows, summaryRows, width]);
  const historyNote = performanceHistoryNote(brokerPerformance.performance);
  const performance = brokerPerformance.performance;
  const historyValues = performanceChartPoints.filter((point) => Number.isFinite(point.close)).length;
  // Nothing else to show: the history's own state replaces the body instead of a footer warning.
  const historyOnly = !hasPositions && figures.length === 0 && historyValues < 2;
  usePaneNoticeFooter({
    registrationId: "analytics:data-notices",
    notices: [
      ...allocationNotices.map((notice) => notice.text),
      ...(historyNote ? [historyNote] : []),
      ...riskFigureNotices(riskRows),
      ...(!historyOnly && brokerPerformance.error && !performance
        ? [`${unavailableHistory} ${brokerPerformance.error}`] : []),
      ...(performance && historyValues < 2 && !historyNote ? ["Account history needs at least two observations for a chart."] : []),
    ],
    focused,
    enabled: hasPositions || hasAccountContent,
    title: "Portfolio data",
  });
  const performancePalette = useMemo(
    () => resolvePerformancePalette(performance),
    [performance],
  );
  // The account's own history: its value in the account currency, or its
  // cumulative return in percent when the broker reports no value.
  const historyChart = useMemo<ChartTableChart | null>(() => {
    if (historyValues < 2) return brokerPerformance.loading && !performance ? { loading: true } : null;
    const returns = resolvePerformanceMetric(performance) === "cumulativeReturn";
    const series = [staticSeries(
      performanceChartPoints.map((point) => scalarPoint(point.date, Number.isFinite(point.close) ? point.close * (returns ? 100 : 1) : null)),
      {
        id: "account-history",
        label: returns ? "Broker return" : buildHistoryAxisLabel({ performance }),
        color: performancePalette.lineColor,
        calendarSpaced: true,
      },
    )];
    return {
      series,
      formatValue: returns
        ? (value: number) => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`
        : (value: number) => formatCompactAmount(value),
      formatAxisValue: returns ? formatPercentAxis : formatHistoryValueAxis,
      ...(performance?.stale ? { legendAccessory: <Text fg={colors.textDim}>cached</Text>, legendAccessoryWidth: 6 } : {}),
      remoteKind: "portfolio-account-history",
    };
  }, [brokerPerformance.loading, historyValues, performance, performanceChartPoints, performancePalette]);

  const handleSectorHeaderClick = useCallback((columnId: string) => {
    setSectorSort((current) => nextHeaderSort(current, columnId as SectorTableColumn["id"], {
      resetTo: { columnId: null, direction: "asc" },
    }));
  }, []);

  useEffect(() => {
    if (activePortfolioId !== currentPortfolioId) {
      setCurrentPortfolioId(activePortfolioId);
    }
  }, [activePortfolioId, currentPortfolioId, setCurrentPortfolioId]);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {portfolioTabs.length === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <Text fg={colors.textMuted}>No portfolios found</Text>
        </Box>
      ) : (
        <>
          {tabStrip && (
            <Box flexDirection="row" height={1}>
              <Box flexShrink={1} overflow="hidden">{tabStrip}</Box>
            </Box>
          )}

          {!hasPositions && !hasAccountContent ? (
            <Box paddingX={1} paddingY={1}>
              <EmptyState
                title="No positions in this portfolio."
                message={accountsError ?? undefined}
                hint={accountsError
                  ? "Reconnect the broker in the Brokers pane (BR), then refresh."
                  : "Add holdings from the Portfolio pane (PF), or connect a broker in BR to sync them."}
              />
            </Box>
          ) : historyOnly ? (
            <PaneStatusBody
              loading={brokerPerformance.loading}
              error={brokerPerformance.error}
              empty
              subject="account history"
              errorTitle={unavailableHistory}
              emptyTitle="Account history needs at least two observations for a chart."
            />
          ) : hasPositions ? (
            <SectorAllocationTable
              focused={focused}
              resetScrollKey={activePortfolioId}
              columns={sectorColumns}
              rows={sortedSectorRows}
              sort={sectorSort}
              selectedSectorId={effectiveSelectedSectorId}
              onHeaderClick={handleSectorHeaderClick}
              onSelectSector={setSelectedSectorId}
              width={width}
              height={bodyHeight}
              before={(
                <ChartTableHeader width={width} height={bodyHeight} tableRows={sortedSectorRows.length}
                  tableChromeRows={chartTableChromeRows(sectorColumns, width)}
                  figures={figures} chart={historyChart} />
              )}
            />
          ) : (
            // A cash-only account: the figures and its history take the body.
            <Box flexDirection="column" height={bodyHeight}>
              <ChartTableHeader width={width} height={bodyHeight} tableRows={0} tableChromeRows={0}
                figures={figures} chart={historyChart} />
            </Box>
          )}
        </>
      )}
    </Box>
  );
}

function PortfolioAnalyticsPane(props: PaneProps) {
  const [view] = usePaneSettingValue("analyticsView", "overview");
  return view === "risk" ? <PortfolioRiskPane {...props} /> : <LegacyPortfolioAnalyticsPane {...props} />;
}

export const portfolioAnalyticsModule: PluginModule = {
  panes: [
    {
      id: "analytics",
      name: "Portfolio Analytics",
      icon: "R",
      component: PortfolioAnalyticsPane,
      headless: portfolioRiskHeadless,
      tableExport: true,
      settings: { fields: [
        { key: "analyticsView", label: "View", type: "select", options: [{ value: "overview", label: "Overview" }, { value: "risk", label: "Risk depth" }] },
        { key: "riskEvidence", label: "Local evidence JSON", type: "text" },
        { key: "equityShift", label: "Index shift (%)", type: "text" },
        { key: "rateShift", label: "10Y shift (bp)", type: "text" },
        { key: "volShift", label: "VIX shift (points)", type: "text" },
      ] },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 80, height: 30 },
      portableShare: {
        private: { params: true, settings: true, state: true },
      },
    },
  ],

  setup(ctx) { portfolioRiskCache.attach(ctx.persistence); },
  dispose() { portfolioRiskCache.reset(); },
  paneTemplates: ["PORT", "MARS"].map(prefix => ({
      id: prefix === "PORT" ? "analytics-pane" : "analytics-mars-pane",
      paneId: "analytics",
      label: prefix === "PORT" ? "Portfolio Analytics" : "Portfolio Market Risk",
      description: "Benchmark-relative risk, factor betas, stress shifts and local account evidence.",
      keywords: ["risk", "analytics", "sharpe", "beta", "sector", "allocation", "portfolio"],
      shortcut: { prefix, argKind: "text", argOptional: true, argPlaceholder: "portfolio-id" },
      headless: portfolioRiskHeadless,
      canCreate: (context) => context.config.portfolios.length > 0,
      createInstance: (context, options) => {
        const portfolioId = resolvePortfolioId(context.config.portfolios, options?.arg) ?? resolveTemplatePortfolioId(context.config.portfolios, context.activeCollectionId);
        return portfolioId ? { params: { portfolioId }, settings: { analyticsView: "risk" } } : null;
      },
    })),
};
