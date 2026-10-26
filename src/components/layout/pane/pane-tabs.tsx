import type { ReactNode } from "react";
import { useUiCapabilities } from "../../../ui";
import { QueryBar } from "../../ui/query-bar";
import { Tabs, type TabsProps } from "../../ui/tabs";
import { usePaneHeaderTabs } from "./header-tabs";
import { chromeBarRows } from "./sizing";

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
  /** Body rows the strip takes, for content sized in rows: a query bar's taller chrome row on the desktop. */
  rows: number;
}

/**
 * A pane's primary tab strip in one call. It registers the strip with the
 * chrome, which draws it in the desktop title bar, and otherwise returns the
 * row the body draws first, so the tabs are described once. Call it above any
 * early return, and draw `strip` above every body state, loading and error
 * included.
 *
 * The strip is chrome: it is there from the first frame and stays while a tab,
 * a filter or a refresh loads, fails or comes back empty, so switching never
 * takes it away. Pass null only while there is nothing to choose between: a
 * sign-in or plan wall, no ticker or portfolio yet, a detail that replaces the
 * tabs by design. A conditional call is listed with its reason in
 * `src/architecture/pane-tabs-allowlist.json`.
 */
export function usePaneTabs(options: PaneTabsOptions | null): PaneTabs {
  const inHeader = usePaneHeaderTabs(options);
  const { nativePaneChrome } = useUiCapabilities();
  if (!options || inHeader) return { strip: null, rows: 0 };
  const { queryBarWidth, ...tabs } = options;
  if (queryBarWidth !== undefined && nativePaneChrome) {
    return {
      strip: <QueryBar width={queryBarWidth} view={{ value: tabs.activeValue ?? "", options: tabs.tabs, onChange: tabs.onSelect }} />,
      rows: chromeBarRows(true),
    };
  }
  return { strip: <Tabs {...tabs} />, rows: 1 };
}
