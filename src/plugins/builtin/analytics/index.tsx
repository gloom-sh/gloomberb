import { Box, Text } from "../../../ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TextAttributes } from "../../../ui";
import { EmptyState, SectionHeading, Tabs, usePaneNoticeFooter } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors } from "../../../theme/colors";
import { convertCurrency } from "../../../utils/format";
import {
  getFocusedCollectionId,
  useAppSelector,
  usePaneInstance,
  usePaneStateValue,
  usePaneAppConfig,
} from "../../../state/app/context";
import { useChartQueries, useFxRatesMap, useTickerFinancialsMap } from "../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../market-data/portfolio-financials";
import { selectEffectiveExchangeRates } from "../../../utils/exchange-rate-map";
import { usePortfolioAccountState } from "../portfolio-list/header";
import { calculatePortfolioSummaryTotals, type ColumnContext } from "../portfolio-list/metrics";
import {
  buildPerformanceChartPoints,
  performanceHistoryNote,
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
  PORTFOLIO_BENCHMARK,
  formatHistoryAxisValue,
  resolvePerformancePalette,
} from "./pane-model";
import {
  buildSectorColumns,
  buildSectorRowsFromPortfolioColumns,
  buildTrackedCurrencies,
  DEFAULT_SECTOR_SORT,
  nextSectorSortPreference,
  sortSectorRows,
  type SectorSortPreference,
} from "./sector-model";
import { describePortfolioTab, resolvePortfolioId, resolveTemplatePortfolioId } from "./portfolio-selection";
import {
  AnalyticsMetricsPanel,
  PortfolioHistorySection,
  SectorAllocationTable,
} from "./view";

function PortfolioAnalyticsPane({ focused, width, height }: PaneProps) {
  const focusedCollectionId = useAppSelector((state) => getFocusedCollectionId(state));
  const portfolios = useAppSelector((state) => state.config.portfolios);
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const tickersBySymbol = useAppSelector((state) => state.tickers);
  const cachedFinancials = useAppSelector((state) => state.financials);
  const cachedExchangeRates = useAppSelector((state) => state.exchangeRates);
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

  const marketFinancials = useTickerFinancialsMap(portfolioTickers, instrumentOptions);
  const financials = useMemo(
    () => buildPortfolioFinancialsMap(portfolioTickers, cachedFinancials, marketFinancials, instrumentOptions),
    [portfolioTickers, cachedFinancials, marketFinancials, instrumentOptions],
  );
  const brokerPerformance = useBrokerPortfolioPerformance(activePortfolio, config);
  const performanceChartPoints = useMemo(
    () => buildPerformanceChartPoints(brokerPerformance.performance),
    [brokerPerformance.performance],
  );
  const accountStateInput = useMemo(() => ({ brokerAccounts, config }), [brokerAccounts, config]);
  const { accountState, accountsError } = usePortfolioAccountState(activePortfolio, accountStateInput);
  const trackedCurrencies = useMemo(
    () => [...buildTrackedCurrencies(portfolioTickers, financials, baseCurrency), accountState?.account.currency],
    [accountState?.account.currency, baseCurrency, financials, portfolioTickers],
  );
  const fetchedExchangeRates = useFxRatesMap(trackedCurrencies);
  const effectiveExchangeRates = selectEffectiveExchangeRates(fetchedExchangeRates, cachedExchangeRates);
  const columnContext = useMemo<ColumnContext>(() => ({
    activeTab: activePortfolioId || undefined,
    baseCurrency,
    exchangeRates: effectiveExchangeRates,
    now: Date.now(),
  }), [activePortfolioId, baseCurrency, effectiveExchangeRates]);

  const portfolioStats = useMemo(
    () => calculatePortfolioSummaryTotals(
      portfolioTickers,
      financials,
      baseCurrency,
      effectiveExchangeRates,
      true,
      activePortfolioId || null,
    ),
    [activePortfolioId, baseCurrency, effectiveExchangeRates, financials, portfolioTickers],
  );

  const returnSeriesResult = useMemo(
    () => buildPortfolioReturnSeries({
      chartTargets,
      chartEntries,
      financials,
      columnContext,
      account: accountState?.account,
    }),
    [accountState, chartEntries, chartTargets, columnContext, financials],
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
        effectiveExchangeRates,
      ),
    }),
    [accountState, activePortfolio, baseCurrency, brokerPerformance.performance, effectiveExchangeRates, portfolioStats],
  );

  const riskRows = useMemo(
    () => hasPositions ? buildAnalyticsRiskRows({
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
    }) : [],
    [beta, betaResult, hasPositions, returnSeriesResult, spyReturnSeries, sharpe],
  );
  const metricsHeight = summaryRows.length === 0 && riskRows.length === 0
    ? 0 : summaryRows.length + (riskRows.length > 0 ? riskRows.length + 5 : 3);
  const historyNote = performanceHistoryNote(brokerPerformance.performance);
  usePaneNoticeFooter({
    registrationId: "analytics:data-notices",
    notices: [...allocationNotices.map((notice) => notice.text), ...(historyNote ? [historyNote] : [])],
    focused,
    enabled: hasPositions || hasAccountContent,
    title: "Portfolio data",
  });
  const availableHistoryChartHeight = height - metricsHeight - 7;
  const historyChartHeight = performanceChartPoints.filter((point) => Number.isFinite(point.close)).length >= 2 && availableHistoryChartHeight >= 5
    ? Math.min(8, availableHistoryChartHeight)
    : 0;
  const showHistoryChart = historyChartHeight >= 5;
  const performancePalette = useMemo(
    () => resolvePerformancePalette(brokerPerformance.performance),
    [brokerPerformance.performance],
  );
  const historyAxisLabel = buildHistoryAxisLabel({
    performance: brokerPerformance.performance,
  });
  const formatHistoryAxis = useCallback((value: number) => (
    formatHistoryAxisValue(value, brokerPerformance.performance)
  ), [brokerPerformance.performance]);

  const handleSectorHeaderClick = useCallback((columnId: string) => {
    setSectorSort((current) => nextSectorSortPreference(current, columnId));
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
          <Box flexDirection="row" height={1}>
            <Box flexShrink={1} overflow="hidden">
              <Tabs
                tabs={portfolioTabs}
                activeValue={activePortfolioId}
                onSelect={handlePortfolioSelect}
                compact
                focused={focused}
              />
            </Box>
          </Box>

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
          ) : (
            <>
              {metricsHeight > 0 && <AnalyticsMetricsPanel
                summaryRows={summaryRows}
                riskRows={riskRows}
                height={metricsHeight}
              />}

              <PortfolioHistorySection
                show={showHistoryChart}
                loading={brokerPerformance.loading}
                error={brokerPerformance.error}
                width={width}
                height={historyChartHeight}
                points={performanceChartPoints}
                palette={performancePalette}
                axisLabel={historyAxisLabel}
                period={brokerPerformance.performance?.period}
                stale={brokerPerformance.performance?.stale}
                formatAxisValue={formatHistoryAxis}
              />

              {hasPositions && (
                <>
                  <Box height={1} paddingX={1}>
                    <SectionHeading title="Holdings by sector" />
                  </Box>

                  <SectorAllocationTable
                    focused={focused}
                    resetScrollKey={activePortfolioId}
                    columns={sectorColumns}
                    rows={sortedSectorRows}
                    sort={sectorSort}
                    selectedSectorId={effectiveSelectedSectorId}
                    onHeaderClick={handleSectorHeaderClick}
                    onSelectSector={setSelectedSectorId}
                  />
                </>
              )}
            </>
          )}
        </>
      )}
    </Box>
  );
}

export const portfolioAnalyticsModule: PluginModule = {
  panes: [
    {
      id: "analytics",
      name: "Portfolio Analytics",
      icon: "R",
      component: PortfolioAnalyticsPane,
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 80, height: 30 },
      portableShare: {
        private: { params: true, settings: true, state: true },
      },
    },
  ],

  paneTemplates: [
    {
      id: "analytics-pane",
      paneId: "analytics",
      label: "Portfolio Analytics",
      description: "Sharpe ratio, beta vs S&P 500, and sector allocation for your portfolio.",
      keywords: ["risk", "analytics", "sharpe", "beta", "sector", "allocation", "portfolio"],
      shortcut: { prefix: "PORT" },
      canCreate: (context) => context.config.portfolios.length > 0,
      createInstance: (context) => {
        const portfolioId = resolveTemplatePortfolioId(context.config.portfolios, context.activeCollectionId);
        return portfolioId ? { params: { portfolioId } } : null;
      },
    },
  ],
};
