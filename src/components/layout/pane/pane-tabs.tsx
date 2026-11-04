import { useCallback, useId, useRef, type ReactNode } from "react";
import { useUiCapabilities } from "../../../ui";
import { QueryBar } from "../../ui/query-bar";
import { Tabs, type TabsProps } from "../../ui/tabs";
import { usePaneFooter, usePaneFooterScopeActive, usePaneViewKeys } from "./footer/registration";
import { useNestedTabsDepth, usePaneHeaderTabs } from "./header-tabs";
import { chromeBarRows } from "./sizing";

/**
 * The keys that walk a nested strip's choices, as `h` and `l` walk the strip
 * above it. Both are free in every pane: `[` and `]` cycle a sort or an expiry,
 * and Shift+H and Shift+L are a chart's.
 */
const PREVIOUS_VIEW_KEY = "{";
const NEXT_VIEW_KEY = "}";
/** After the view's own hints. */
const VIEW_KEYS_FOOTER_ORDER = 50;

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
 *
 * A nested strip (inside `NestedPaneTabs`) takes `{` and `}` to walk its
 * choices, the outermost focused one in the pane. As a query-bar view
 * (`queryBarWidth`) right under the title bar's strip (a research tab's
 * views, a Fixed Income section's) it starts its bar, where the terminal's
 * tab row starts; one a level deeper is the shown view's own switch (Holders'
 * Table and Chart under Ownership's views) and sits at the right, as a view's
 * presentation does, and so does a stack detail's own (an app's Chart and
 * Evidence in Apps).
 */
export function usePaneTabs(options: PaneTabsOptions | null): PaneTabs {
  const inHeader = usePaneHeaderTabs(options);
  const { nativePaneChrome } = useUiCapabilities();
  const depth = useNestedTabsDepth();
  // A pane's own strip drawn in its body (the terminal's) walks with h and l.
  useNestedViewKeys(options && !inHeader && depth > 0 ? options : null);
  if (!options || inHeader) return { strip: null, rows: 0 };
  const { queryBarWidth, ...tabs } = options;
  if (queryBarWidth !== undefined && nativePaneChrome) {
    const view = { value: tabs.activeValue ?? "", options: tabs.tabs, onChange: tabs.onSelect, start: depth === 1 };
    return {
      strip: <QueryBar width={queryBarWidth} view={view} />,
      rows: chromeBarRows(true),
    };
  }
  return { strip: <Tabs {...tabs} />, rows: 1 };
}

/**
 * `{` and `}` on a focused nested strip with choices, cycling past either end.
 * Only the outermost focused one in the pane has them (`usePaneViewKeys`).
 * Their hint joins the pane's own; it never adds a footer row of its own.
 */
function useNestedViewKeys(options: PaneTabsOptions | null) {
  const scopeActive = usePaneFooterScopeActive();
  const choices = options ? options.tabs.filter((tab) => !tab.disabled).length : 0;
  const owns = usePaneViewKeys(!!options?.focused && scopeActive && choices > 1);
  const latest = useRef(options);
  latest.current = options;
  const step = useCallback((direction: -1 | 1) => {
    const current = latest.current;
    const enabled = current?.tabs.filter((tab) => !tab.disabled) ?? [];
    if (!current || enabled.length < 2) return;
    const index = enabled.findIndex((tab) => tab.value === current.activeValue);
    const from = index >= 0 ? index : direction > 0 ? -1 : 0;
    current.onSelect(enabled[(from + direction + enabled.length) % enabled.length]!.value);
  }, []);
  const registrationId = `nested-view-keys:${useId()}`;
  usePaneFooter(registrationId, () => owns ? {
    order: VIEW_KEYS_FOOTER_ORDER,
    hints: [{ id: "nested-view", key: `${PREVIOUS_VIEW_KEY}${NEXT_VIEW_KEY}`, label: "view", title: "Next View", onPress: () => step(1), besideOthers: true }],
    keys: [
      { id: "previous-view", key: PREVIOUS_VIEW_KEY, label: "", title: "Previous View", onPress: () => step(-1) },
      { id: "next-view", key: NEXT_VIEW_KEY, label: "", title: "Next View", onPress: () => step(1) },
    ],
  } : null, [owns, step]);
}
