import { useCallback } from "react";
import type { TickerResearchTabProps } from "../../../../types/plugin";
import {
  useAppDispatch,
  useOptionalPaneInstanceId,
  usePaneInstance,
  usePaneTicker,
} from "../../../../state/app/context";
import { getTickerResearchPaneSettings } from "../settings";
import { OverviewTab } from "../overview-tab";

/** Registered by the chart composer, in the same plugin as this tab. */
const CHART_TAB_ID = "chart";

export function OverviewResearchTab({ width, focused }: TickerResearchTabProps) {
  const { ticker, financials } = usePaneTicker();
  const dispatch = useAppDispatch();
  const paneId = useOptionalPaneInstanceId();
  const paneInstance = usePaneInstance();
  // A pane locked to one tab has nowhere to go.
  const lockedToOneTab = getTickerResearchPaneSettings(paneInstance?.settings).hideTabs;
  const openChart = useCallback(() => {
    if (paneId) dispatch({ type: "UPDATE_PANE_STATE", paneId, patch: { activeTabId: CHART_TAB_ID } });
  }, [dispatch, paneId]);
  return (
    <OverviewTab
      width={width}
      focused={focused}
      ticker={ticker}
      financials={financials}
      onOpenChart={paneId && !lockedToOneTab ? openChart : undefined}
    />
  );
}
