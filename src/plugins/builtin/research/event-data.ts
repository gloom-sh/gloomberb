import { useCallback, useMemo } from "react";
import type { AnalystResearchData, CorporateActionsData } from "../../../types/financials";
import { usePaneTicker } from "../../../state/app/context";
import { useAssetData } from "../../runtime";
import { loadAnalystResearch } from "./client";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { useBoundTicker as useSymbolBinding, useTickerRequest } from "../shared/ticker-request";
import { loadEarningsCalendar } from "../earnings/data/cache";
import { calendarEventOf, listingDay, withResolvedEarnings } from "../shared/earnings-calendar";
import { buildEventRows, eventSourceNotice, isFundListing, type EventFinancials } from "./event-model";
import { fundCorporateActions } from "../../../market-data/fund-actions";

/**
 * What every Events view reads for its ticker: the corporate actions feed
 * resolved against the earnings calendar, the analyst estimates and the
 * listing's statements, built into event rows once. EVT's Earnings and
 * Dividends views and EE share it, so they agree on every figure.
 */
export function useEventData(variant: "corporate-actions" | "earnings-estimates" = "corporate-actions") {
  const dataProvider = useAssetData();
  const cloudSession = useResearchCloudSession();
  const binding = useSymbolBinding();
  const { symbol, exchange, currency } = binding;
  // The shared ticker snapshot already subscribes to financials for this pane.
  // Only the statements and the trailing EPS are read, so the rows do not rebuild on price ticks.
  const { financials: tickerFinancials } = usePaneTicker();
  const quarterlyStatements = tickerFinancials?.quarterlyStatements;
  const annualStatements = tickerFinancials?.annualStatements;
  const statementScope = tickerFinancials?.statementScope;
  const financialCurrency = tickerFinancials?.financialCurrency;
  const trailingEps = tickerFinancials?.fundamentals?.eps;
  const trailingEpsCurrency = tickerFinancials?.fundamentals?.epsCurrency;
  const trailingEpsSource = tickerFinancials?.fundamentals?.trailingEpsSource;
  const fundamentalsCurrency = tickerFinancials?.fundamentals?.financialCurrency;
  const marketCapCurrency = tickerFinancials?.fundamentals?.marketCapCurrency;
  const quoteCurrency = tickerFinancials?.quote?.currency;
  // The listing's type, as `fn EVT` reads it: a fund's events are its distributions, never a feed's EPS rows.
  const quoteType = tickerFinancials?.quote?.instrumentType ?? binding.ticker?.metadata.assetCategory;
  const quoteName = tickerFinancials?.quote?.name;
  const quoteExchange = tickerFinancials?.quote?.listingExchangeName || tickerFinancials?.quote?.exchangeName;
  const metadataType = tickerFinancials?.quoteMetadata?.instrumentType;
  const financialsData = useMemo<EventFinancials | null>(
    () => (quarterlyStatements || financialCurrency || trailingEps != null || quoteType || metadataType || quoteName ? {
      quarterlyStatements: quarterlyStatements ?? [],
      // Their last end names the fiscal quarters (Q1 FY2027), as GUIDE and ERN name them.
      annualStatements: annualStatements ?? [],
      statementScope,
      financialCurrency,
      fundamentals: { eps: trailingEps, epsCurrency: trailingEpsCurrency, financialCurrency: fundamentalsCurrency, marketCapCurrency, trailingEpsSource },
      quote: quoteCurrency || quoteType || quoteName ? { currency: quoteCurrency ?? "", instrumentType: quoteType, name: quoteName, exchangeName: quoteExchange } : null,
      quoteMetadata: metadataType ? { instrumentType: metadataType } : null,
    } : null),
    [annualStatements, financialCurrency, fundamentalsCurrency, marketCapCurrency, metadataType, quarterlyStatements, quoteCurrency, quoteExchange, quoteName, quoteType,
      statementScope, trailingEps, trailingEpsCurrency, trailingEpsSource],
  );
  const actionsLoader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider?.getCorporateActions) throw new Error("Corporate actions source unavailable");
    return dataProvider.getCorporateActions(nextSymbol, nextExchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [dataProvider, cloudSession.requestKey]);
  const analystLoader = useCallback(async (nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!dataProvider?.getAnalystResearch) return null;
    return loadAnalystResearch(dataProvider, nextSymbol, nextExchange, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [dataProvider, cloudSession.requestKey]);
  // The earnings calendar's next report, which the rows are resolved against as `earnings` and ERN read it.
  const calendarLoader = useCallback((nextSymbol: string, _exchange: string, forceRefresh: boolean) => (
    loadEarningsCalendar(dataProvider, [nextSymbol], { force: forceRefresh }).then((result) => calendarEventOf(result.events, nextSymbol))
  ), [dataProvider]);
  const {
    data: recordedActions,
    loading: actionsLoading,
    error: actionsError,
    reload: reloadActions,
  } = useTickerRequest<CorporateActionsData>(actionsLoader, symbol, exchange, ["corporate-actions", cloudSession.requestKey]);
  const fund = isFundListing(financialsData, recordedActions);
  const {
    data: calendarEvent,
    loading: calendarLoading,
    error: calendarError,
    reload: reloadCalendar,
  } = useTickerRequest(calendarLoader, symbol, exchange, ["corporate-actions-calendar"]);
  // The listing's own day, as `earnings` reads a report date: SIE:XETRA's has passed once Berlin's day has.
  const today = listingDay(exchange);
  const actionsData = useMemo(
    () => recordedActions ? (fund ? fundCorporateActions(recordedActions) : withResolvedEarnings(recordedActions, calendarEvent, today)) : null,
    [calendarEvent, fund, recordedActions, today],
  );
  const {
    data: analystData,
    loading: analystLoading,
    error: analystError,
    reload: reloadAnalyst,
  } = useTickerRequest<AnalystResearchData | null>(analystLoader, symbol, exchange, undefined, !fund);
  const displayCurrency = actionsData?.currency ?? analystData?.currency ?? currency;
  const allRows = useMemo(() => (
    buildEventRows(actionsData, analystData, financialsData, displayCurrency)
  ), [actionsData, analystData, displayCurrency, financialsData]);
  const sourceNotice = useMemo(() => (
    actionsLoading || analystLoading
      ? null
      : eventSourceNotice({
        variant,
        symbol: symbol ?? "this ticker",
        actions: actionsData,
        actionsError,
        // A fund has no analyst estimates to miss.
        estimates: fund ? null : analystData,
        estimatesError: fund ? null : analystError,
      })
  ), [actionsData, actionsError, actionsLoading, analystData, analystError, analystLoading, fund, symbol, variant]);
  const loading = actionsLoading || analystLoading || (calendarLoading && !!recordedActions);
  const authWall = !loading && !actionsData && !analystData && (isCloudSessionRequired(actionsError) || isCloudSessionRequired(analystError));
  // Parallel requests fail with the same message ("No ticker selected"), so the
  // footer must report each distinct reason once.
  const error = [...new Set([actionsError, analystError].filter((value): value is string => !!value && !isCloudSessionRequired(value)))]
    .join(" | ") || null;
  const reload = useCallback(() => {
    reloadActions();
    reloadAnalyst();
    reloadCalendar();
  }, [reloadActions, reloadAnalyst, reloadCalendar]);
  return {
    ...binding,
    cloudSession,
    tickerFinancials,
    financialsData,
    fund,
    recordedActions,
    actionsData,
    analystData,
    calendarError,
    today,
    allRows,
    sourceNotice,
    loading,
    authWall,
    error,
    reload,
    statedExDate: tickerFinancials?.fundamentals?.exDividendDate,
  };
}
