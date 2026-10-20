import { PerpEquityRow } from "../../perps/equity-row";
import { PerpMarketsSection } from "../../perps/markets-section";
import { perpetualListing } from "../../../../tickers/perpetual-listing";
import { useCallback } from "react";
import type { TickerResearchTabProps } from "../../../../types/plugin";
import {
  useAppDispatch,
  useOptionalPaneInstanceId,
  usePaneInstance,
  usePaneTicker,
} from "../../../../state/app/context";
import { usePluginAppActions } from "../../../runtime";
import { getTickerResearchPaneSettings } from "../settings";
import { OverviewTab } from "../overview-tab";
import { useOpenResearchTab } from "../research-tab-navigation";
import type { OverviewFunctionLink } from "./types";
import { useOverviewDividend } from "./dividend";

/** Registered by the chart composer, in the same plugin as this tab. */
const CHART_TAB_ID = "chart";

export function OverviewResearchTab({ width, height, focused }: TickerResearchTabProps) {
  const { ticker, financials } = usePaneTicker();
  const dispatch = useAppDispatch();
  const paneId = useOptionalPaneInstanceId();
  const paneInstance = usePaneInstance();
  const openResearchTab = useOpenResearchTab();
  const { createPaneFromTemplate } = usePluginAppActions();
  const dividend = useOverviewDividend(ticker?.metadata.ticker ?? null, ticker?.metadata.exchange ?? "", financials?.fundamentals);
  // A pane locked to one tab has nowhere to go.
  const lockedToOneTab = getTickerResearchPaneSettings(paneInstance?.settings).hideTabs;
  const openChart = useCallback(() => {
    if (paneId) dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: CHART_TAB_ID } });
  }, [dispatch, paneId]);
  // A figure opens its function here when this pane has that tab, and in its own pane otherwise.
  const openFunction = useCallback((link: OverviewFunctionLink) => {
    if (link.tabId && openResearchTab?.(link.tabId)) return;
    const symbol = ticker?.metadata.ticker;
    if (symbol) createPaneFromTemplate(link.templateId, { symbol, symbols: [symbol], ticker });
  }, [createPaneFromTemplate, openResearchTab, ticker]);
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
      perpetuals={ticker ? (contentWidth: number) => {
        const instrumentType = financials?.quote?.instrumentType ?? ticker.metadata.assetCategory;
        // A contract's own DES shows its funding and premium; a stock or a coin lists its markets across venues.
        return perpetualListing(ticker.metadata.ticker, ticker.metadata.exchange)
          ? <PerpEquityRow symbol={ticker.metadata.ticker} exchange={ticker.metadata.exchange} instrumentType={instrumentType} />
          : <PerpMarketsSection symbol={ticker.metadata.ticker} exchange={ticker.metadata.exchange} instrumentType={instrumentType} width={contentWidth} />;
      } : undefined}
    />
  );
}
