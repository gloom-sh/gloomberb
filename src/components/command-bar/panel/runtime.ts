import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { ScrollBoxRenderable } from "../../../ui";
import type { AppState } from "../../../state/app/context";
import type { LayoutBounds } from "../../../plugins/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { CommandBarPanelProps } from "./types";
import { useCommandBarKeyboardShortcuts } from "../keyboard-shortcuts";
import { useCommandBarListNavigation } from "../list/navigation";
import {
  resolveListPageTarget,
  type CommandBarListRow,
  type ListJump,
  type ListScreenState,
  type ResultItem,
} from "../list/model";
import { useCommandBarMultiSelectRuntime } from "../multi-select-runtime";
import { useCommandBarPanelState } from "./state";
import type { ThemePickerHandle } from "../theme-picker";
import type { CommandBarRoute } from "../workflow/types";

interface CommandBarPanelRuntimeOptions {
  acceptRootShortcutTab: () => boolean;
  acceptSelectedShortcutTab: () => boolean;
  activateListSelection: (options?: { secondary?: boolean; item?: ResultItem }) => void;
  applyThemePreview: (themeId: string | null) => void;
  cellHeightPx: number;
  cellWidthPx: number;
  closeAll: (options?: { revertThemePreview?: boolean }) => void;
  commitTheme: (themeId: string) => void;
  committedThemeId: string;
  confirmCurrentRoute: () => void | Promise<void>;
  currentRoute: CommandBarRoute | null;
  currentRouteRef: MutableRefObject<CommandBarRoute | null>;
  dismissCommandBar: () => void;
  markRootSelectionNavigated: () => void;
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  nativePaneChrome: boolean;
  nativeWindowChrome?: boolean;
  onNativeOccluderChange?: (rect: LayoutBounds | null) => void;
  persistConfig: (nextConfig: AppState["config"]) => void;
  pluginRegistry: PluginRegistry;
  popRoute: () => void;
  resetAssist: () => boolean;
  rootGhostSuffix: string | null;
  rootModeKind: string;
  rootShortcutFeedback: string | null;
  routeListState: ListScreenState | null;
  setActiveListQuery: (query: string) => void;
  setRootHoveredIdx: Dispatch<SetStateAction<number | null>>;
  setRootSelectedIdx: Dispatch<SetStateAction<number>>;
  setRouteStack: Dispatch<SetStateAction<CommandBarRoute[]>>;
  stateRef: MutableRefObject<AppState>;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  themePickerFilter: string;
  themePickerRef: RefObject<ThemePickerHandle | null>;
  titleBarOverlay: boolean | undefined;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  visibleListStateRef: MutableRefObject<ListScreenState | null>;
}

export function useCommandBarPanelRuntime({
  acceptRootShortcutTab,
  acceptSelectedShortcutTab,
  activateListSelection,
  applyThemePreview,
  cellHeightPx,
  cellWidthPx,
  closeAll,
  commitTheme,
  committedThemeId,
  confirmCurrentRoute,
  currentRoute,
  currentRouteRef,
  dismissCommandBar,
  markRootSelectionNavigated,
  nativeListScrollRef,
  nativePaneChrome,
  nativeWindowChrome,
  onNativeOccluderChange,
  persistConfig,
  pluginRegistry,
  popRoute,
  resetAssist,
  rootGhostSuffix,
  rootModeKind,
  rootShortcutFeedback,
  routeListState,
  setActiveListQuery,
  setRootHoveredIdx,
  setRootSelectedIdx,
  setRouteStack,
  stateRef,
  termHeight,
  termWidth,
  themePickerActive,
  themePickerFilter,
  themePickerRef,
  titleBarOverlay,
  updateTopRoute,
  visibleListStateRef,
}: CommandBarPanelRuntimeOptions): CommandBarPanelProps {
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

  const {
    commitMultiSelectPicker,
    handleMultiSelectMove,
    handleMultiSelectSelect,
    handleMultiSelectToggle,
    showCustomMultiSelectPicker,
  } = useCommandBarMultiSelectRuntime({
    currentRoute,
    pluginRegistry,
    setRouteStack,
    updateTopRoute,
    });

  const handleConfirmRoute = useCallback(() => {
    void confirmCurrentRoute();
  }, [confirmCurrentRoute]);

  useCommandBarKeyboardShortcuts({
    acceptRootShortcutTab,
    acceptSelectedShortcutTab,
    activateListSelection,
    commitMultiSelectPicker,
    confirmCurrentRoute,
    currentRoute,
    dismissCommandBar,
    handleMultiSelectMove,
    handleMultiSelectToggle,
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
    showCustomMultiSelectPicker,
    termHeight,
    termWidth,
    themePickerActive,
    themePickerFilter,
    titleBarOverlay,
    updateTopRoute,
    visibleListStateRef,
  });
  listViewportRef.current = { rows: nativeListRows, lines: panelLayout.listBodyHeight };

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
    bodyHeight: panelLayout.bodyHeight,
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
    onConfirmRoute: handleConfirmRoute,
    onListHoverIndex: setHoveredIndex,
    onListRowMouseDown: handleListRowMouseDown,
    onListScroll: handleListScroll,
    onMultiSelectCommit: commitMultiSelectPicker,
    onMultiSelectSelect: handleMultiSelectSelect,
    onMultiSelectToggle: handleMultiSelectToggle,
    onNativeOccluderChange,
    onOverlayClose: closeAll,
    onQueryChange: setActiveListQuery,
    onThemeCommit: handleThemeCommit,
    onThemePreview: applyThemePreview,
    panelBounds: panelLayout.panelBounds,
    queryDisplayWidth: panelLayout.queryDisplayWidth,
    rootGhostSuffix,
    rootShortcutFeedback,
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
