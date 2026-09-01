import {
  useCallback,
  useRef,
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from "react";
import type { NativeSelectElement } from "../../ui/native-select";
import type { ScrollBoxRenderable } from "../../../ui";
import type { AppState } from "../../../state/app/context";
import type { LayoutBounds } from "../../../plugins/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { CommandBarPanelProps } from "./types";
import { useCommandBarKeyboardShortcuts } from "../keyboard-shortcuts";
import { useCommandBarListNavigation } from "../list/navigation";
import type { ListScreenState, ResultItem } from "../list/model";
import { useCommandBarMultiSelectRuntime } from "../multi-select-runtime";
import { useCommandBarPanelState } from "./state";
import type { ThemePickerHandle } from "../theme-picker";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "../workflow/types";

type OpenWorkflowFieldPicker = (
  route: CommandBarWorkflowRoute,
  field: CommandBarWorkflowField,
) => void;

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
  focusWorkflowField: (fieldId: string) => void;
  getWorkflowFieldStringValue: (
    field: CommandBarWorkflowField,
    value: CommandBarFieldValue | undefined,
  ) => string;
  getWorkflowInputRef: CommandBarPanelProps["getWorkflowInputRef"];
  markRootSelectionNavigated: () => void;
  moveWorkflowFocus: (delta: number) => void;
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  nativePaneChrome: boolean;
  nativeWindowChrome?: boolean;
  onNativeOccluderChange?: (rect: LayoutBounds | null) => void;
  openWorkflowFieldPicker: OpenWorkflowFieldPicker;
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
  setWorkflowNativeSelectRef: (fieldId: string, element: NativeSelectElement | null) => void;
  stateRef: MutableRefObject<AppState>;
  submitWorkflowRoute: (route: CommandBarWorkflowRoute) => void | Promise<void>;
  syncActiveWorkflowTextarea: (route: CommandBarWorkflowRoute) => void;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  themePickerFilter: string;
  themePickerRef: RefObject<ThemePickerHandle | null>;
  titleBarOverlay: boolean | undefined;
  updateTopRoute: (updater: (route: CommandBarRoute) => CommandBarRoute) => void;
  updateWorkflowValue: (fieldId: string, value: CommandBarFieldValue) => void;
  visibleListStateRef: MutableRefObject<ListScreenState | null>;
  workflowNativeSelectRefs: MutableRefObject<Map<string, NativeSelectElement>>;
  workflowScrollRef: RefObject<ScrollBoxRenderable | null>;
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
  focusWorkflowField,
  getWorkflowFieldStringValue,
  getWorkflowInputRef,
  markRootSelectionNavigated,
  moveWorkflowFocus,
  nativeListScrollRef,
  nativePaneChrome,
  nativeWindowChrome,
  onNativeOccluderChange,
  openWorkflowFieldPicker,
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
  setWorkflowNativeSelectRef,
  stateRef,
  submitWorkflowRoute,
  syncActiveWorkflowTextarea,
  termHeight,
  termWidth,
  themePickerActive,
  themePickerFilter,
  themePickerRef,
  titleBarOverlay,
  updateTopRoute,
  updateWorkflowValue,
  visibleListStateRef,
  workflowNativeSelectRefs,
  workflowScrollRef,
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
    updateWorkflowValue,
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
    getWorkflowFieldStringValue,
    handleMultiSelectMove,
    handleMultiSelectToggle,
    moveListSelection,
    moveWorkflowFocus,
    nativePaneChrome,
    openWorkflowFieldPicker,
    popRoute,
    resetAssist,
    rootModeKind,
    setActiveListQuery,
    submitWorkflowRoute,
    themePickerActive,
    themePickerRef,
    updateWorkflowValue,
    visibleListStateRef,
    workflowNativeSelectRefs,
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
    titleBarOverlay,
    updateTopRoute,
    visibleListStateRef,
  });

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
    getWorkflowInputRef,
    hasChromeRow: panelLayout.hasChromeRow,
    labelWidth: panelLayout.labelWidth,
    listBodyHeight: panelLayout.listBodyHeight,
    nativeListRows,
    nativeListScrollRef,
    nativeOccluderRect: panelLayout.nativeOccluderRect,
    nativePaneChrome,
    onBack: popRoute,
    onConfirmRoute: handleConfirmRoute,
    onFieldFocus: focusWorkflowField,
    onFieldPickerOpen: openWorkflowFieldPicker,
    onFieldValueChange: updateWorkflowValue,
    onListHoverIndex: setHoveredIndex,
    onListRowMouseDown: handleListRowMouseDown,
    onListScroll: handleListScroll,
    onMoveFieldFocus: moveWorkflowFocus,
    onMultiSelectCommit: commitMultiSelectPicker,
    onMultiSelectSelect: handleMultiSelectSelect,
    onMultiSelectToggle: handleMultiSelectToggle,
    onNativeOccluderChange,
    onNativeSelectRef: setWorkflowNativeSelectRef,
    onOverlayClose: closeAll,
    onQueryChange: setActiveListQuery,
    onThemeCommit: handleThemeCommit,
    onThemePreview: applyThemePreview,
    onWorkflowActiveTextareaSync: syncActiveWorkflowTextarea,
    onWorkflowSubmit: submitWorkflowRoute,
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
    workflowScrollRef,
  };
}
