import { useCallback, useMemo } from "react";
import type { StatItem } from "../../../components";
import { useFxRatesMap } from "../../../market-data/hooks";
import { buildPortfolioFinancialsMap } from "../../../market-data/portfolio-financials";
import { useAppSelector } from "../../../state/app/context";
import { useLiveTickerFinancialsMap } from "../../../state/hooks/live-ticker-financials";
import { priceColor } from "../../../theme/colors";
import type { Portfolio, TickerRecord } from "../../../types/ticker";
import type { BrokerPortfolioPerformance } from "../../../types/trading";
import { convertCurrency, formatCompactAmount, formatPercentRaw } from "../../../utils/format";
import { isFiniteNumber } from "../../../utils/guards";
import {
  formatMarginLeverage,
  resolvePortfolioMarketValue,
  resolvePortfolioNetLiquidation,
} from "../portfolio-list/account-metrics";
import { calculatePortfolioSummaryTotals } from "../portfolio-list/metrics";
import { buildPortfolioSummaryNotices } from "../portfolio-list/summary";
import { usePortfolioAccountState } from "../portfolio-list/summary/live-accounts";
import { buildSectorRowsFromPortfolioColumns, buildTrackedCurrencies } from "./sector-model";

const NO_TICKERS: TickerRecord[] = [];

/** The broker's latest cumulative return and the period it covers. */
function latestBrokerReturn(performance: BrokerPortfolioPerformance | null): StatItem | null {
  const latest = performance?.points
    .filter((point) => Number.isFinite(Date.parse(point.date)))
    .toSorted((left, right) => Date.parse(left.date) - Date.parse(right.date))
    .at(-1);
  const value = latest?.cumulativeReturn;
  if (!isFiniteNumber(value)) return null;
  return {
    id: "broker-return",
    label: "Broker return",
    value: formatPercentRaw(value * 100),
    detail: performance?.period,
    color: priceColor(value),
  };
}

/**
 * The current holdings valued as the portfolio pane values them: quotes scoped
 * to the portfolio's broker contracts, converted to the base currency. The
 * sector table and the account band come from here rather than from the risk
 * model, which only takes USD equity histories.
 */
export function usePortfolioBook(
  portfolio: Portfolio | null,
  tickers: TickerRecord[],
  {
    enabled,
    brokerReturn,
  }: {
    enabled: boolean;
    /** Account history for the band's broker return; null when the view already states a return. */
    brokerReturn: BrokerPortfolioPerformance | null;
  },
) {
  const baseCurrency = useAppSelector((state) => state.config.baseCurrency);
  const cachedFinancials = useAppSelector((state) => state.financials);
  const brokerAccounts = useAppSelector((state) => state.brokerAccounts);
  const config = useAppSelector((state) => state.config);
  const bookTickers = enabled ? tickers : NO_TICKERS;
  const instrumentOptions = useMemo(() => ({ portfolioId: portfolio?.id }), [portfolio?.id]);
  // Totals and weights are aggregates, so the positions stream as background targets.
  const marketFinancials = useLiveTickerFinancialsMap(bookTickers, {
    surface: "portfolio",
    visible: false,
    weight: 20,
    instrumentOptions,
  });
  const financials = useMemo(
    () => buildPortfolioFinancialsMap(bookTickers, cachedFinancials, marketFinancials, instrumentOptions),
    [bookTickers, cachedFinancials, marketFinancials, instrumentOptions],
  );
  const accountStateInput = useMemo(() => ({ brokerAccounts, config }), [brokerAccounts, config]);
  const { accountState } = usePortfolioAccountState(enabled ? portfolio : null, accountStateInput);
  const accountCurrency = accountState?.account.currency ?? "";
  const trackedCurrencies = useMemo(
    () => enabled ? [...buildTrackedCurrencies(bookTickers, financials, baseCurrency), accountCurrency || null] : [],
    [accountCurrency, baseCurrency, bookTickers, enabled, financials],
  );
  const exchangeRates = useFxRatesMap(trackedCurrencies);
  const convertAccountValue = useCallback(
    (value: number) => convertCurrency(value, accountCurrency, baseCurrency, exchangeRates),
    [accountCurrency, baseCurrency, exchangeRates],
  );
  const columnContext = useMemo(() => ({
    activeTab: portfolio?.id,
    baseCurrency,
    exchangeRates,
    now: Date.now(),
  }), [baseCurrency, exchangeRates, portfolio?.id]);

  const sectors = useMemo(
    () => buildSectorRowsFromPortfolioColumns(bookTickers, financials, columnContext),
    [bookTickers, columnContext, financials],
  );
  const totals = useMemo(
    () => calculatePortfolioSummaryTotals(bookTickers, financials, baseCurrency, exchangeRates, true, portfolio?.id ?? null),
    [baseCurrency, bookTickers, exchangeRates, financials, portfolio?.id],
  );
  const band = useMemo(() => {
    const account = accountState?.account;
    const basis = accountState?.snapshotBasis;
    const netLiquidation = resolvePortfolioNetLiquidation(totals, account, convertAccountValue, basis);
    const hasMarketValue = totals.hasPositions || isFiniteNumber(account?.grossPositionValue);
    const marginLeverage = hasMarketValue
      ? formatMarginLeverage(netLiquidation, resolvePortfolioMarketValue(totals, account, convertAccountValue, basis))
      : null;
    const accountValue = (id: string, label: string, value: number | undefined): StatItem[] => (
      value == null ? [] : [{ id, label, value: formatCompactAmount(convertAccountValue(value)) }]
    );
    const brokerReturnItem = latestBrokerReturn(brokerReturn);
    return [
      ...(netLiquidation == null ? [] : [{ id: "net-liquidation", label: "Net Liq", value: formatCompactAmount(netLiquidation) }]),
      ...accountValue("cash", "Cash", account?.totalCashValue),
      ...(marginLeverage ? [{ id: "margin-leverage", label: "Margin Lev", value: marginLeverage }] : []),
      ...accountValue("buying-power", "BP", account?.buyingPower),
      ...accountValue("excess-liquidity", "Excess", account?.excessLiquidity),
      ...(brokerReturnItem ? [brokerReturnItem] : []),
    ];
  }, [accountState, brokerReturn, convertAccountValue, totals]);
  const accountNotices = useMemo(
    // Only a broker account has a band to qualify; cost gaps affect P&L, which it does not show.
    () => accountState
      ? buildPortfolioSummaryNotices({
        totals: { ...totals, unavailableCostSymbols: undefined },
        accountState,
        baseCurrency,
        convertAccountValue,
      })
      : [],
    [accountState, baseCurrency, convertAccountValue, totals],
  );

  return {
    baseCurrency,
    sectors,
    band,
    accountNotices,
    accountSource: accountState?.sourceLabel ?? null,
  };
}
