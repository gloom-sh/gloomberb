import { Box, Text } from "../../../ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TextAttributes } from "../../../ui";
import { EmptyState, Notice, Tabs } from "../../../components";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors } from "../../../theme/colors";
import { convertCurrency } from "../../../utils/format";
import { wrapTextLines } from "../../../utils/text-wrap";
import {
  getFocusedCollectionId,
  useAppSelector,
  usePaneInstance,
  usePaneStateValue,
} from "../../../state/app/context";
import { useChartQueries, useFxRatesMap, useTickerFinancialsMap } from "../../../market-data/hooks";
import { selectEffectiveExchangeRates } from "../../../utils/exchange-rate-map";
import { usePortfolioAccountState } from "../portfolio-list/header";
import { calculatePortfolioSummaryTotals, type ColumnContext } from "../portfolio-list/metrics";
import {
  buildPerformanceChartPoints,
  performanceHistoryNote,
  useBrokerPortfolioPerformance,
} from "./broker-performance";
import {
  computeDatedBeta,
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
  const config = useAppSelector((state) => state.config);
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

  const chartTargets = useMemo(
    () => buildPortfolioChartTargets(portfolioTickers),
    [portfolioTickers],
  );
  const chartRequests = useMemo(
    () => chartTargets.map((target) => target.request),
    [chartTargets],
  );
  const chartEntries = useChartQueries(chartRequests);

  const spyRequest = useMemo(
    () => ({
      instrument: { symbol: "SPY", exchange: "" },
      bufferRange: "1Y" as const,
      granularity: "range" as const,
    }),
    [],
  );
  const spyChartRequests = useMemo(() => [spyRequest], [spyRequest]);
  const spyChartEntries = useChartQueries(spyChartRequests);

  const marketFinancials = useTickerFinancialsMap(portfolioTickers);
  const financials = useMemo(() => {
    const merged = new Map(cachedFinancials);
    for (const [symbol, data] of marketFinancials) {
      merged.set(symbol, data);
    }
    return merged;
  }, [cachedFinancials, marketFinancials]);
  const brokerPerformance = useBrokerPortfolioPerformance(activePortfolio, config);
  const performanceChartPoints = useMemo(
    () => buildPerformanceChartPoints(brokerPerformance.performance),
    [brokerPerformance.performance],
  );
  const accountStateInput = useMemo(() => ({ brokerAccounts, config }), [brokerAccounts, config]);
  const { accountState, accountsError } = usePortfolioAccountState(activePortfolio, accountStateInput);
  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(portfolioTickers, financials, baseCurrency),
    [baseCurrency, financials, portfolioTickers],
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
    () => (portfolioReturns ? computeSharpeRatio(portfolioReturns) : null),
    [portfolioReturns],
  );

  const beta = useMemo(
    () => (portfolioReturnSeries ? computeDatedBeta(portfolioReturnSeries, spyReturnSeries.returns) : null),
    [portfolioReturnSeries, spyReturnSeries],
  );

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

  const summaryRows = useMemo(
    () => buildAnalyticsSummaryRows({
      accountState,
      activePortfolio,
      brokerPerformance: brokerPerformance.performance,
      portfolioStats,
      convertAccountValue: (value) => convertCurrency(
        value,
        accountState?.account.currency || baseCurrency,
        baseCurrency,
        effectiveExchangeRates,
      ),
    }),
    [accountState, activePortfolio, baseCurrency, brokerPerformance.performance, effectiveExchangeRates, portfolioStats],
  );

  const riskRows = useMemo(
    () => buildAnalyticsRiskRows({
      sharpe,
      beta,
      coverage: returnSeriesResult.coverage,
      missingCount: returnSeriesResult.missingCount,
      unvaluedCount: returnSeriesResult.unvaluedCount,
      unsupportedReason: returnSeriesResult.unsupportedReason,
      historyIntegrity: returnSeriesResult.historyIntegrity,
      benchmarkIntegrity: spyReturnSeries.integrity,
    }),
    [beta, returnSeriesResult, spyReturnSeries.integrity, sharpe],
  );
  const metricsHeight = summaryRows.length + riskRows.length + 5;
  const historyNote = performanceHistoryNote(brokerPerformance.performance);
  const noticeWidth = Math.max(1, width - 2);
  const noticeHeight = allocationNotices.reduce((total, notice) => total + wrapTextLines(notice.text, noticeWidth).length, 0)
    + (historyNote ? wrapTextLines(historyNote, noticeWidth).length : 0);
  // Keep table rows available after active data warnings wrap.
  const availableHistoryChartHeight = height - metricsHeight - 7 - noticeHeight;
  const historyChartHeight = performanceChartPoints.length >= 2 && availableHistoryChartHeight >= 5
    ? Math.min(8, availableHistoryChartHeight)
    : 0;
  const showHistoryChart = historyChartHeight >= 5;
  const performancePalette = useMemo(
    () => resolvePerformancePalette(brokerPerformance.performance),
    [brokerPerformance.performance],
  );
  const historyAxisLabel = buildHistoryAxisLabel({
    performance: brokerPerformance.performance,
    activePortfolio,
    baseCurrency,
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

          {!hasPositions ? (
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
              <AnalyticsMetricsPanel
                summaryRows={summaryRows}
                riskRows={riskRows}
                height={metricsHeight}
              />

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
                note={historyNote}
                formatAxisValue={formatHistoryAxis}
              />

              <Box height={1} paddingX={1}>
                <Text fg={colors.textDim} attributes={TextAttributes.BOLD}>
                  Holdings by sector
                </Text>
              </Box>
              <Box paddingX={1} flexDirection="column">
                {allocationNotices.map((notice) => <Notice key={notice.text} tone={notice.tone}>{notice.text}</Notice>)}
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
