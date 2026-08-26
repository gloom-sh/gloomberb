import { useEffect, useMemo, type Dispatch, type SetStateAction } from "react";
import {
  buildListRows,
  buildNativeListRows,
  type ListScreenState,
} from "../list/model";
import {
  resolveCommandBarPanelLayout,
} from "./layout";
import type { CommandBarRoute } from "../workflow/types";

type RefLike<T> = { current: T };

interface UseCommandBarPanelStateOptions {
  cellHeightPx: number;
  cellWidthPx: number;
  currentRoute: CommandBarRoute | null;
  nativePaneChrome: boolean;
  routeListState: ListScreenState | null;
  setRootSelectedIdx: Dispatch<SetStateAction<number>>;
  showCustomMultiSelectPicker: boolean;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  titleBarOverlay: boolean | undefined;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  visibleListStateRef: RefLike<ListScreenState | null>;
}

export function useCommandBarPanelState({
  cellHeightPx,
  cellWidthPx,
  currentRoute,
  nativePaneChrome,
  routeListState,
  setRootSelectedIdx,
  showCustomMultiSelectPicker,
  termHeight,
  termWidth,
  themePickerActive,
  titleBarOverlay,
  updateTopRoute,
  visibleListStateRef,
}: UseCommandBarPanelStateOptions) {
  visibleListStateRef.current = routeListState;

  useEffect(() => {
    const listState = routeListState;
    if (!listState) return;
    const maxIndex = Math.max(0, listState.results.length - 1);
    if (listState.selectedIdx <= maxIndex) return;

    if (currentRoute && (currentRoute.kind === "mode" || currentRoute.kind === "picker" || currentRoute.kind === "pane-settings")) {
      updateTopRoute((route) => {
        if (route.kind === "mode" || route.kind === "picker" || route.kind === "pane-settings") {
          return {
            ...route,
            selectedIdx: maxIndex,
            hoveredIdx: route.hoveredIdx != null && route.hoveredIdx > maxIndex ? null : route.hoveredIdx,
          };
        }
        return route;
      });
      return;
    }
    setRootSelectedIdx(maxIndex);
  }, [currentRoute, routeListState, setRootSelectedIdx, updateTopRoute]);

  const visibleListState = routeListState
    && (routeListState.kind === "root"
      || routeListState.kind === "mode"
      || routeListState.kind === "picker"
      || routeListState.kind === "pane-settings")
    ? routeListState
    : null;
  const hasVisibleListState = visibleListState != null;
  const listRows = useMemo(
    () => (visibleListState ? buildListRows(visibleListState) : []),
    [visibleListState?.results],
  );
  const nativeListRows = useMemo(
    () => (visibleListState ? buildNativeListRows(visibleListState, listRows) : []),
    [listRows, visibleListState?.emptyLabel, visibleListState?.searching],
  );
  const listRowIndexByGlobalIndex = useMemo(() => {
    const indexByGlobalIndex = new Map<number, number>();
    listRows.forEach((row, index) => {
      if (row.kind === "item") {
        indexByGlobalIndex.set(row.globalIdx, index);
      }
    });
    return indexByGlobalIndex;
  }, [listRows]);
  const panelLayout = useMemo(() => resolveCommandBarPanelLayout({
    cellHeightPx,
    cellWidthPx,
    currentRoute,
    hasVisibleListState,
    nativeListRowCount: nativeListRows.length,
    nativePaneChrome,
    showCustomMultiSelectPicker,
    termHeight,
    termWidth,
    themePickerActive,
    titleBarOverlay,
  }), [
    cellHeightPx,
    cellWidthPx,
    currentRoute,
    hasVisibleListState,
    nativeListRows.length,
    nativePaneChrome,
    showCustomMultiSelectPicker,
    termHeight,
    termWidth,
    themePickerActive,
    titleBarOverlay,
  ]);
  const selectedListRowIndex = visibleListState
    ? listRowIndexByGlobalIndex.get(visibleListState.selectedIdx) ?? -1
    : -1;
  const bodySlotKey = showCustomMultiSelectPicker
    ? "picker:field-multi-select"
    : themePickerActive
      ? "theme-picker"
      : currentRoute?.kind === "picker"
        ? `picker:${currentRoute.pickerId}`
        : currentRoute?.kind ?? "root";

  return {
    bodySlotKey,
    listRows,
    nativeListRows,
    panelLayout,
    selectedScrollRowIndex: selectedListRowIndex,
    visibleListState,
  };
}
