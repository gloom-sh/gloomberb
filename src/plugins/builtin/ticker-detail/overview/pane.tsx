import { PerpEquityRow } from "../../perps/equity-row";
import { PerpMarketsSection } from "../../perps/markets-section";
import { TickerNewsHeadlines } from "../../news/overview-headlines";
import { TICKER_NEWS_TAB_ID, TICKER_NEWS_TEMPLATE_ID } from "../../news/ticker-news";
import { perpetualListing } from "../../../../tickers/perpetual-listing";
import { useCallback } from "react";
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
import type { OverviewFunctionLink } from "./types";
import { useOverviewDividend } from "./dividend";
import { useTickerSnapshotState } from "../../../../market-data/hooks";
import { taxRatesFromSettings } from "../../../../market-data/tax-equivalent";
import { PaneLinkMenu } from "../../../../components";
import { FunctionLinkRow } from "./components";
import { OVERVIEW_CHART_SCALE_SETTING, parseOverviewChartScaleChoice } from "./chart-scale";

/** Registered by the chart composer, in the same plugin as this tab. */
const CHART_TAB_ID = "chart";
/** The ticker's news: Buzz's News view in this pane, otherwise CN. */
const NEWS: OverviewFunctionLink = { name: "News", tabId: TICKER_NEWS_TAB_ID, templateId: TICKER_NEWS_TEMPLATE_ID };

export function OverviewResearchTab({ width, height, focused }: TickerResearchTabProps) {
  const { symbol, ticker, financials } = usePaneTicker();
  const snapshot = useTickerSnapshotState(symbol, ticker);
  const dispatch = useAppDispatch();
  const paneId = useOptionalPaneInstanceId();
  const paneInstance = usePaneInstance();
  const openResearchTab = useOpenResearchTab();
  const { createPaneFromTemplate } = usePluginAppActions();
  const dividend = useOverviewDividend(ticker?.metadata.ticker ?? null, ticker?.metadata.exchange ?? "", financials?.fundamentals);
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
  return (
    <OverviewTab
      width={width}
      height={height}
      focused={focused}
      ticker={ticker}
      financials={financials}
      onOpenChart={paneId && !lockedToOneTab ? openChart : undefined}
      onOpenFunction={openFunction}
      dividend={dividend}
      snapshot={snapshot}
      tax={taxRatesFromSettings(paneInstance?.settings)}
      chartScale={parseOverviewChartScaleChoice(chartScale)}
      onChartScaleChange={paneId ? setChartScale : undefined}
      news={ticker ? (contentWidth: number) => (
        <TickerNewsHeadlines ticker={ticker} width={contentWidth} openNewsView={openNewsView}>
          <PaneLinkMenu><FunctionLinkRow link={NEWS} onOpen={openFunction} /></PaneLinkMenu>
        </TickerNewsHeadlines>
      ) : undefined}
      perpetuals={ticker ? (contentWidth: number) => {
        const instrumentType = financials?.quote?.instrumentType ?? ticker.metadata.assetCategory;
        // A contract's own DES shows its funding and premium; a stock or a coin lists its markets across venues.
        return perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange)
          ? <PerpEquityRow symbol={ticker.metadata.ticker} exchange={ticker.metadata.exchange} instrumentType={instrumentType} />
          : <PerpMarketsSection symbol={ticker.metadata.ticker} exchange={ticker.metadata.exchange} instrumentType={instrumentType} quote={financials?.quote} width={contentWidth} />;
      } : undefined}
    />
  );
}
