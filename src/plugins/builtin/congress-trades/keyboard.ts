import { useCallback } from "react";
import { type DataTableKeyEvent } from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import type { CongressTab, DetailMode } from "./model";

/** The key that picks each tab, in strip order. */
export const CONGRESS_TAB_KEYS: ReadonlyArray<{ key: string; value: CongressTab; label: string }> = [
  { key: "1", value: "trades", label: "Trades" },
  { key: "2", value: "members", label: "Members" },
  { key: "3", value: "tickers", label: "Tickers" },
];

/**
 * The footer hints bind n, p, t, m and o (see footer.ts); the table keeps only
 * the refresh and the tab keys.
 */
export function useCongressTradesKeyboard({
  detailMode,
  focused,
  load,
  selectTab,
}: {
  detailMode: DetailMode;
  focused: boolean;
  load: (refresh?: boolean) => void;
  selectTab: (tab: string) => void;
}) {
  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, () => load(true), { stopPropagation: true })
  ), [load]);

  // 1, 2 and 3 pick a tab; the pane menu lists them with these keys.
  useShortcut((event) => {
    if (!focused || detailMode || event.targetEditable || event.defaultPrevented) return;
    const tab = CONGRESS_TAB_KEYS.find((entry) => isPlainKey(event, entry.key));
    if (!tab) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    selectTab(tab.value);
  });

  return { handleRootKeyDown };
}
