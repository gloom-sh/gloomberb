import type { ReactNode } from "react";
import { useUiCapabilities } from "../../../ui";
import { QueryBar } from "../../ui/query-bar";
import { Tabs, type TabsProps } from "../../ui/tabs";
import { usePaneHeaderTabs } from "./header-tabs";

export interface PaneTabsOptions extends TabsProps {
  /**
   * Nested under another title-bar strip on the desktop (a Ticker Research
   * tab), offer the choice as a `QueryBar` view of this width instead of a
   * second tab row. The terminal keeps its `Tabs` row.
   */
  queryBarWidth?: number;
}

export interface PaneTabs {
  /** What the body draws first: the `Tabs` row, or null while the chrome draws the strip. */
  strip: ReactNode;
  /** Body rows the strip takes, for content sized in rows. */
  rows: 0 | 1;
}

/**
 * A pane's primary tab strip in one call. It registers the strip with the
 * chrome, which draws it in the desktop title bar, and otherwise returns the
 * row the body draws first, so the tabs are described once. Call it above any
 * early return, and pass null while the pane has no strip (a sign-in wall).
 */
export function usePaneTabs(options: PaneTabsOptions | null): PaneTabs {
  const inHeader = usePaneHeaderTabs(options);
  const { nativePaneChrome } = useUiCapabilities();
  if (!options || inHeader) return { strip: null, rows: 0 };
  const { queryBarWidth, ...tabs } = options;
  if (queryBarWidth !== undefined && nativePaneChrome) {
    return {
      strip: <QueryBar width={queryBarWidth} view={{ value: tabs.activeValue ?? "", options: tabs.tabs, onChange: tabs.onSelect }} />,
      rows: 1,
    };
  }
  return { strip: <Tabs {...tabs} />, rows: 1 };
}
