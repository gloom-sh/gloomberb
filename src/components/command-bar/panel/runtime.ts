import { useCallback, useRef } from "react";
import type { LayoutBounds } from "../../../layout/pane-manager";
import type { CommandBarPanelProps } from "./types";
import type { CommandBarNavigationState } from "../routing/navigation-state";
import type { CommandBarEnvironment } from "../surface/environment";
import { useCommandBarKeyboardShortcuts } from "../keyboard-shortcuts";
import { useCommandBarListNavigation } from "../list/navigation";
import {
  resolveListPageTarget,
  type CommandBarListRow,
  type ListJump,
  type ListScreenState,
  type ResultItem,
} from "../list/model";
import { useCommandBarPanelState } from "./state";

interface CommandBarPanelRuntimeOptions {
  env: CommandBarEnvironment;
  nav: CommandBarNavigationState;
  acceptRootShortcutTab: () => boolean;
  acceptSelectedShortcutTab: () => boolean;
  activateListSelection: (options?: { secondary?: boolean; item?: ResultItem }) => void;
  applyThemePreview: (themeId: string | null) => void;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  commitTheme: (themeId: string) => void;
  /** A click outside the bar: a dismissal, unlike `closeAll` after a commit. */
  dismissOverlay: () => void;
  onNativeOccluderChange?: (rect: LayoutBounds | null) => void;
  resetAssist: () => boolean;
  rootGhostSuffix: string | null;
  rootShortcutFeedback: string | null;
  routeListState: ListScreenState | null;
  setActiveListQuery: (query: string) => void;
  themePickerActive: boolean;
  themePickerFilter: string;
}

export function useCommandBarPanelRuntime({
  env,
  nav,
  acceptRootShortcutTab,
  acceptSelectedShortcutTab,
  activateListSelection,
  applyThemePreview,
  closeAll,
  commitTheme,
  dismissOverlay,
  onNativeOccluderChange,
  resetAssist,
  rootGhostSuffix,
  rootShortcutFeedback,
  routeListState,
  setActiveListQuery,
  themePickerActive,
  themePickerFilter,
}: CommandBarPanelRuntimeOptions): CommandBarPanelProps {
  const {
    cellHeightPx,
    cellWidthPx,
    nativeListScrollRef,
    nativePaneChrome,
    nativeWindowChrome,
    persistConfig,
    state: { config: { theme: committedThemeId } },
    stateRef,
    termHeight,
    termWidth,
    themePickerRef,
    titleBarOverlay,
    visibleListStateRef,
  } = env;
  const {
    currentRoute,
    currentRouteRef,
    dismissCommandBar,
    markRootSelectionNavigated,
    popRoute,
    rootModeInfo: { kind: rootModeKind },
    setRootHoveredIdx,
    setRootSelectedIdx,
    setRouteStack,
    updateTopRoute,
  } = nav;
  const activateListSelectionRef = useRef(activateListSelection);
  activateListSelectionRef.current = activateListSelection;

  const {
    handleListRowMouseDown,
    handleListScroll,
    moveListSelection,
    setHoveredIndex,
  } = useCommandBarListNavigation({
    activateListSelectionRef,
    currentRouteRef,
    markRootSelectionNavigated,
    setRootHoveredIdx,
    setRootSelectedIdx,
    setRouteStack,
    visibleListStateRef,
  });

  // The laid-out list, filled in below once the panel has measured it. Page
  // keys only read it when pressed, by which time it matches the screen.
  const listViewportRef = useRef<{ rows: readonly CommandBarListRow[]; lines: number }>({ rows: [], lines: 1 });
  const jumpListSelection = useCallback((target: ListJump) => {
    const listState = visibleListStateRef.current;
    if (!listState || listState.results.length === 0) return;
    const { rows, lines } = listViewportRef.current;
    const nextIndex = target === "first"
      ? 0
      : target === "last"
        ? listState.results.length - 1
        : resolveListPageTarget(rows, listState.selectedIdx, lines, target === "page-down" ? 1 : -1);
    moveListSelection(nextIndex - listState.selectedIdx);
  }, [moveListSelection, visibleListStateRef]);

  useCommandBarKeyboardShortcuts({
    acceptRootShortcutTab,
    acceptSelectedShortcutTab,
    activateListSelection,
    currentRoute,
    dismissCommandBar,
    jumpListSelection,
    moveListSelection,
    popRoute,
    resetAssist,
    rootModeKind,
    setActiveListQuery,
    themePickerActive,
    themePickerRef,
    visibleListStateRef,
  });

  const {
    bodySlotKey,
    nativeListRows,
    panelLayout,
    selectedScrollRowIndex,
    visibleListState,
  } = useCommandBarPanelState({
    cellHeightPx,
    cellWidthPx,
    currentRoute,
    nativePaneChrome,
    nativeWindowChrome,
    rootShortcutFeedback,
    routeListState,
    setRootSelectedIdx,
    termHeight,
    termWidth,
    themePickerActive,
    themePickerFilter,
    titleBarOverlay,
    updateTopRoute,
    visibleListStateRef,
  });
  listViewportRef.current = { rows: nativeListRows, lines: panelLayout.listBodyHeight };

  const runShortcut = useCallback(() => activateListSelectionRef.current(), []);

  const handleThemeCommit = useCallback((themeId: string) => {
    const nextConfig = {
      ...stateRef.current.config,
      theme: themeId,
    };
    commitTheme(themeId);
    persistConfig(nextConfig);
    closeAll({ revertThemePreview: false });
  }, [closeAll, commitTheme, persistConfig, stateRef]);

  return {
    bodySlotKey,
    committedThemeId,
    contentPadding: panelLayout.contentPadding,
    currentRoute,
    hasChromeRow: panelLayout.hasChromeRow,
    labelWidth: panelLayout.labelWidth,
    listBodyHeight: panelLayout.listBodyHeight,
    nativeListRows,
    nativeListScrollRef,
    nativeOccluderRect: panelLayout.nativeOccluderRect,
    nativePaneChrome,
    onBack: popRoute,
    onListHoverIndex: setHoveredIndex,
    onListRowMouseDown: handleListRowMouseDown,
    onListScroll: handleListScroll,
    onNativeOccluderChange,
    onOverlayClose: dismissOverlay,
    onQueryChange: setActiveListQuery,
    onThemeCommit: handleThemeCommit,
    onThemePreview: applyThemePreview,
    panelBounds: panelLayout.panelBounds,
    queryDisplayWidth: panelLayout.queryDisplayWidth,
    rootGhostSuffix,
    rootShortcutFeedback,
    onRunShortcut: runShortcut,
    selectedScrollRowIndex,
    termHeight,
    termWidth,
    themePickerActive,
    themePickerFilter,
    themePickerRef,
    trailingWidth: panelLayout.trailingWidth,
    visibleListState,
  };
}
