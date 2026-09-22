import { useCallback } from "react";
import { type DataTableKeyEvent } from "../../../components";
import { useShortcut } from "../../../react/input";
import { isPlainKey } from "../../../utils/keyboard";
import type { CongressTab, DetailMode } from "./model";

export function useCongressTradesKeyboard({
  activeTab,
  detailMode,
  focused,
  load,
  loadPreviousYear,
  loadMore,
  openSelectedTicker,
  openSelectedTradeMember,
  openSelectedTradeSource,
  selectTab,
}: {
  activeTab: CongressTab;
  detailMode: DetailMode;
  focused: boolean;
  load: (refresh?: boolean) => void;
  /** Null once there is no earlier year left to ask for. */
  loadPreviousYear: (() => void) | null;
  loadMore: (() => void) | null;
  openSelectedTicker: () => void;
  openSelectedTradeMember: () => void;
  openSelectedTradeSource: () => void;
  selectTab: (tab: string) => void;
}) {
  const handleDetailKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (detailMode?.kind === "member" || detailMode?.kind === "ticker") {
      return false;
    }
    if (isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTradeSource();
      return true;
    }
    if (isPlainKey(event, "t")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTicker();
      return true;
    }
    if (isPlainKey(event, "m")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTradeMember();
      return true;
    }
    return false;
  }, [detailMode?.kind, openSelectedTicker, openSelectedTradeMember, openSelectedTradeSource]);

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (loadMore && isPlainKey(event, "n")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      loadMore();
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      load(true);
      return true;
    }
    if (loadPreviousYear && isPlainKey(event, "p")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      loadPreviousYear();
      return true;
    }
    if ((activeTab === "trades" || activeTab === "tickers") && isPlainKey(event, "t")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTicker();
      return true;
    }
    if (activeTab === "trades" && isPlainKey(event, "m")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTradeMember();
      return true;
    }
    if (activeTab === "trades" && isPlainKey(event, "o")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelectedTradeSource();
      return true;
    }
    return false;
  }, [activeTab, load, loadMore, loadPreviousYear, openSelectedTicker, openSelectedTradeMember, openSelectedTradeSource]);

  useShortcut((event) => {
    if (!focused || detailMode || event.targetEditable) return;
    if (event.name === "1") {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectTab("trades");
    } else if (event.name === "2") {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectTab("members");
    } else if (event.name === "3") {
      event.preventDefault?.();
      event.stopPropagation?.();
      selectTab("tickers");
    }
  });

  return { handleDetailKeyDown, handleRootKeyDown };
}
