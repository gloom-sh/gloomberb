import { useEffect, useMemo, useRef, type Dispatch, type SetStateAction } from "react";
import {
  buildListRows,
  buildNativeListRows,
  getListRowsHeight,
  resolveSelectedScrollLine,
  type ListScreenState,
} from "../list/model";
import {
  resolveCommandBarPanelLayout,
} from "./layout";
import { matchThemeOptions } from "../theme-picker";
import type { CommandBarRoute } from "../workflow/types";

type RefLike<T> = { current: T };

interface UseCommandBarPanelStateOptions {
  cellHeightPx: number;
  cellWidthPx: number;
  currentRoute: CommandBarRoute | null;
  nativePaneChrome: boolean;
  nativeWindowChrome?: boolean;
  rootShortcutFeedback: string | null;
  routeListState: ListScreenState | null;
  setRootSelectedIdx: Dispatch<SetStateAction<number>>;
  showCustomMultiSelectPicker: boolean;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  themePickerFilter: string;
  titleBarOverlay: boolean | undefined;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  visibleListStateRef: RefLike<ListScreenState | null>;
}

export function useCommandBarPanelState({
  cellHeightPx,
  cellWidthPx,
  currentRoute,
  nativePaneChrome,
  nativeWindowChrome,
  rootShortcutFeedback,
  routeListState,
  setRootSelectedIdx,
  showCustomMultiSelectPicker,
  termHeight,
  termWidth,
  themePickerActive,
  themePickerFilter,
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
    nativeListRows.forEach((row, index) => {
      if (row.kind === "item") {
        indexByGlobalIndex.set(row.globalIdx, index);
      }
    });
    return indexByGlobalIndex;
  }, [nativeListRows]);

  const hasRootFeedback = visibleListState?.kind === "root" && rootShortcutFeedback !== null;
  // One row per matching theme, or the one row the empty message occupies.
  const themePickerRowCount = useMemo(
    () => (themePickerActive ? Math.max(1, matchThemeOptions(themePickerFilter).length) : 0),
    [themePickerActive, themePickerFilter],
  );
  const panelLayout = useMemo(() => resolveCommandBarPanelLayout({
    cellHeightPx,
    cellWidthPx,
    currentRoute,
    hasRootFeedback,
    hasVisibleListState,
    nativeListRowCount: getListRowsHeight(nativeListRows),
    nativePaneChrome,
    nativeWindowChrome,
    showCustomMultiSelectPicker,
    termHeight,
    termWidth,
    themePickerActive,
    themePickerRowCount,
    titleBarOverlay,
  }), [
    cellHeightPx,
    cellWidthPx,
    currentRoute,
    hasRootFeedback,
    hasVisibleListState,
    nativeListRows,
    nativePaneChrome,
    nativeWindowChrome,
    showCustomMultiSelectPicker,
    termHeight,
    termWidth,
    themePickerActive,
    themePickerRowCount,
    titleBarOverlay,
  ]);
  const selectedListRowIndex = visibleListState
    ? listRowIndexByGlobalIndex.get(visibleListState.selectedIdx) ?? -1
    : -1;
  const selectedIdx = visibleListState?.selectedIdx ?? 0;
  const selectionMoveRef = useRef({ selectedIdx, movedDown: false });
  if (selectionMoveRef.current.selectedIdx !== selectedIdx) {
    selectionMoveRef.current = {
      selectedIdx,
      movedDown: selectedIdx > selectionMoveRef.current.selectedIdx,
    };
  }
  const selectedScrollLineIndex = resolveSelectedScrollLine(
    nativeListRows,
    selectedListRowIndex,
    selectionMoveRef.current.movedDown,
  );
  const bodySlotKey = showCustomMultiSelectPicker
    ? "picker:field-multi-select"
    : themePickerActive
      ? "theme-picker"
      : currentRoute?.kind === "picker"
        ? `picker:${currentRoute.pickerId}`
        : currentRoute?.kind ?? "root";

  return {
    bodySlotKey,
    nativeListRows,
    panelLayout,
    selectedScrollRowIndex: selectedScrollLineIndex,
    visibleListState,
  };
}
