import { PerpEquityRow } from "../../perps/equity-row";
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

/** Registered by the chart composer, in the same plugin as this tab. */
const CHART_TAB_ID = "chart";

export function OverviewResearchTab({ width, focused }: TickerResearchTabProps) {
  const { ticker, financials } = usePaneTicker();
  const dispatch = useAppDispatch();
  const paneId = useOptionalPaneInstanceId();
  const paneInstance = usePaneInstance();
  const openResearchTab = useOpenResearchTab();
  const { createPaneFromTemplate } = usePluginAppActions();
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
      focused={focused}
      ticker={ticker}
      financials={financials}
      onOpenChart={paneId && !lockedToOneTab ? openChart : undefined}
      onOpenFunction={openFunction}
      perpetuals={ticker ? <PerpEquityRow symbol={ticker.metadata.ticker} instrumentType={financials?.quote?.instrumentType ?? ticker.metadata.assetCategory} /> : undefined}
    />
  );
}
