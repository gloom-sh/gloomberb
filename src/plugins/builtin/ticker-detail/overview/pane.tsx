import { PerpEquityRow } from "../../perps/equity-row";
import { PerpMarketsSection } from "../../perps/markets-section";
import { TickerNewsHeadlines } from "../../news/overview-headlines";
import { TICKER_NEWS_TAB_ID, TICKER_NEWS_TEMPLATE_ID } from "../../news/ticker-news";
import { perpetualListing } from "../../../../tickers/perpetual-listing";
import { useCallback, useMemo } from "react";
import type { TickerResearchTabProps } from "../../../../types/plugin";
import {
  useAppDispatch,
  useOptionalPaneInstanceId,
  usePaneInstance,
  usePaneSettingValue,
  usePaneTicker,
} from "../../../../state/app/context";
import { usePluginAppActions } from "../../../runtime";
import { getTickerResearchPaneSettings } from "../settings";
import { OverviewTab } from "../overview-tab";
import { useOpenResearchTab } from "../research-tab-navigation";
import { useOpenDescription } from "../../shared/open-description";
import type { OverviewFunctionLink } from "./types";
import { useOverviewDividend } from "./dividend";
import { useAhPair } from "../adr-pair/ah";
import { useListingBoardLot } from "./board-lot";
import { useTickerSnapshotState } from "../../../../market-data/hooks";
import { taxRatesFromSettings } from "../../../../market-data/tax-equivalent";
import { PaneLinkMenu } from "../../../../components";
import { FunctionLinkRow } from "./components";
import { OVERVIEW_CHART_SCALE_SETTING, parseOverviewChartScaleChoice } from "./chart-scale";
import { useCoinOverview } from "./coin";
import { buildOverviewBeta, overviewBetaRequest } from "./model";
import { useRelationshipHistories } from "../../correlation/relationship/history";
import { buildRelationshipAnalysis, DEFAULT_RELATIONSHIP_CORRELATION_WINDOW, DEFAULT_RELATIONSHIP_RANGE } from "../../correlation/relationship/model";

/** Registered by the chart composer, in the same plugin as this tab. */
const CHART_TAB_ID = "chart";
/** The ticker's news: Buzz's News view in this pane, otherwise CN. */
const NEWS: OverviewFunctionLink = { name: "News", tabId: TICKER_NEWS_TAB_ID, templateId: TICKER_NEWS_TEMPLATE_ID };

export function OverviewResearchTab({ width, height, focused }: TickerResearchTabProps) {
  const { symbol, ticker, financials } = usePaneTicker();
  const betaRequest = ticker ? overviewBetaRequest(ticker, financials) : null;
  const { data: betaHistory, error: betaError } = useRelationshipHistories(
    betaRequest?.pair ?? null, betaRequest?.range ?? DEFAULT_RELATIONSHIP_RANGE, ticker?.metadata.exchange ?? "",
  );
  const beta = useMemo(() => {
    const [left, right] = betaHistory ?? [];
    if (betaError || !left || !right) return null;
    return buildOverviewBeta(buildRelationshipAnalysis(left.points, right.points, DEFAULT_RELATIONSHIP_CORRELATION_WINDOW).stats);
  }, [betaError, betaHistory]);
  const coin = useCoinOverview(ticker, financials, focused);
  const snapshot = useTickerSnapshotState(symbol, ticker);
  const dispatch = useAppDispatch();
  const paneId = useOptionalPaneInstanceId();
  const paneInstance = usePaneInstance();
  const openResearchTab = useOpenResearchTab();
  const { createPaneFromTemplate } = usePluginAppActions();
  const openDescription = useOpenDescription();
  const dividend = useOverviewDividend(ticker?.metadata.ticker ?? null, ticker?.metadata.exchange ?? "", financials?.fundamentals);
  // An A+H company's other line and the premium between them, beside the ADR row; the row opens that line's DES.
  const ah = useAhPair(ticker?.metadata.ticker ?? null, ticker?.metadata.exchange || financials?.quote?.listingExchangeName, financials?.quote);
  // A Hong Kong or Singapore line's board lot, the shares one lot trades in.
  const boardLot = useListingBoardLot(ticker?.metadata.ticker ?? null, ticker?.metadata.exchange || financials?.quote?.listingExchangeName);
  // A pane locked to one tab has nowhere to go.
  const lockedToOneTab = getTickerResearchPaneSettings(paneInstance?.settings).hideTabs;
  // The chart's scale, once set from the pane menu, holds for every ticker the pane shows.
  const [chartScale, setChartScale] = usePaneSettingValue<unknown>(OVERVIEW_CHART_SCALE_SETTING, "auto");
  const openChart = useCallback(() => {
    if (paneId) dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: CHART_TAB_ID } });
  }, [dispatch, paneId]);
  // A figure opens its function here when this pane has that tab, and in its own pane otherwise.
  const openFunction = useCallback((link: OverviewFunctionLink) => {
    if (link.tabId && openResearchTab?.(link.tabId)) return;
    const symbol = ticker?.metadata.ticker;
    if (symbol) createPaneFromTemplate(link.templateId, { symbol, symbols: [symbol], ticker });
  }, [createPaneFromTemplate, openResearchTab, ticker]);
  // A headline opens its story in this pane's News view when it has one.
  const openNewsView = useCallback(() => !!openResearchTab?.(TICKER_NEWS_TAB_ID), [openResearchTab]);
  const instrumentType = financials?.quote?.instrumentType ?? ticker?.metadata.assetCategory;
  const onContract = !!ticker && !!perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange);
  return (
    <OverviewTab
      width={width}
      height={height}
      focused={focused}
      ticker={ticker}
      financials={financials}
      beta={beta}
      coin={coin}
      onOpenChart={paneId && !lockedToOneTab ? openChart : undefined}
      onOpenFunction={openFunction}
      onOpenListing={openDescription}
      dividend={dividend}
      ah={ah}
      boardLot={boardLot}
      snapshot={snapshot}
      tax={taxRatesFromSettings(paneInstance?.settings)}
      chartScale={parseOverviewChartScaleChoice(chartScale)}
      onChartScaleChange={paneId ? setChartScale : undefined}
      news={ticker ? (contentWidth: number) => (
        <TickerNewsHeadlines ticker={ticker} width={contentWidth} openNewsView={openNewsView}>
          <PaneLinkMenu><FunctionLinkRow link={NEWS} onOpen={openFunction} /></PaneLinkMenu>
        </TickerNewsHeadlines>
      ) : undefined}
      // A contract's own DES shows its funding and premium under its price; a stock or a coin lists its markets
      // across venues after its own range, chart and figures.
      perpetuals={ticker && onContract
        ? <PerpEquityRow symbol={ticker.metadata.ticker} exchange={ticker.metadata.exchange} instrumentType={instrumentType} />
        : undefined}
      perpetualMarkets={ticker && !onContract ? (contentWidth: number) => (
        <PerpMarketsSection symbol={ticker.metadata.ticker} exchange={ticker.metadata.exchange} instrumentType={instrumentType} quote={financials?.quote} width={contentWidth} />
      ) : undefined}
    />
  );
}
