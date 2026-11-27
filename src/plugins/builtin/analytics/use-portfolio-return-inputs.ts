import { useMemo } from "react";
import type { TickerFinancials } from "../../../types/financials";
import type { TickerRecord } from "../../../types/ticker";
import type { BrokerAccount } from "../../../types/trading";
import { useChartQueries, useFxRatesMap } from "../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../market-data/portfolio-financials";
import { useLiveTickerFinancialsMap, useSampledValue } from "../../../state/hooks/live-ticker-financials";
import type { ColumnContext } from "../portfolio-list/metrics";
import { buildTrackedCurrencies } from "../portfolio-list/pane/data";
import {
  buildBenchmarkReturnSeries,
  buildPortfolioChartTargets,
  buildPortfolioReturnSeries,
  PORTFOLIO_BENCHMARK,
} from "./pane-model";

export interface UsePortfolioReturnInputsOptions {
  portfolioTickers: TickerRecord[];
  portfolioId: string | undefined;
  cachedFinancials: Map<string, TickerFinancials>;
  baseCurrency: string;
  sampleMs: number;
  weight: number;
  account?: BrokerAccount;
  extraCurrencies?: readonly (string | null | undefined)[];
  benchmarkExchange?: string;
  skipBenchmarkWhenEmpty?: boolean;
}

export function usePortfolioReturnInputs({
  portfolioTickers,
  portfolioId,
  cachedFinancials,
  baseCurrency,
  sampleMs,
  weight,
  account,
  extraCurrencies,
  benchmarkExchange = PORTFOLIO_BENCHMARK.exchange,
  skipBenchmarkWhenEmpty = false,
}: UsePortfolioReturnInputsOptions) {
  const instrumentOptions = useMemo(() => ({ portfolioId }), [portfolioId]);
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
      instrument: { symbol: PORTFOLIO_BENCHMARK.symbol, exchange: benchmarkExchange },
      bufferRange: "1Y" as const,
      granularity: "range" as const,
    }),
    [benchmarkExchange],
  );
  const spyChartRequests = useMemo(
    () => (skipBenchmarkWhenEmpty && portfolioTickers.length === 0 ? [] : [spyRequest]),
    [portfolioTickers.length, skipBenchmarkWhenEmpty, spyRequest],
  );
  const spyChartEntries = useChartQueries(spyChartRequests);

  const marketFinancials = useLiveTickerFinancialsMap(portfolioTickers, {
    surface: "portfolio",
    visible: false,
    weight,
    instrumentOptions,
  });
  const financials = useMemo(
    () => buildPortfolioFinancialsMap(portfolioTickers, cachedFinancials, marketFinancials, instrumentOptions),
    [portfolioTickers, cachedFinancials, marketFinancials, instrumentOptions],
  );
  const statsFinancials = useSampledValue(
    financials,
    sampleMs,
    `${portfolioId ?? ""}\u001f${[...financials.keys()].join(",")}`,
  );
  const trackedCurrencies = useMemo(
    () => buildTrackedCurrencies(portfolioTickers, financials, null, baseCurrency, extraCurrencies),
    [baseCurrency, extraCurrencies, financials, portfolioTickers],
  );
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  const columnContext = useMemo<ColumnContext>(() => ({
    activeTab: portfolioId,
    baseCurrency,
    exchangeRates,
    now: Date.now(),
  }), [baseCurrency, exchangeRates, portfolioId]);

  const returnSeriesResult = useMemo(
    () => buildPortfolioReturnSeries({
      chartTargets,
      chartEntries,
      financials: statsFinancials,
      columnContext,
      account,
    }),
    [account, chartEntries, chartTargets, columnContext, statsFinancials],
  );
  const spyReturnSeries = useMemo(
    () => buildBenchmarkReturnSeries(spyRequest, spyChartEntries),
    [spyChartEntries, spyRequest],
  );

  return {
    financials,
    exchangeRates,
    columnContext,
    returnSeriesResult,
    spyReturnSeries,
  };
}
