import { AsciiText, Box, Text, compactContextMenuItems, useContextMenu, useUiHost, type BoxRenderable } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRendererHost, useUiCapabilities } from "../../../ui";
import { useViewport } from "../../../react/input";
import { useDialogState } from "../../../ui/dialog";
import { scheduleConfigSave } from "../../../state/config-save-scheduler";
import type { DesktopDockPreviewState, DesktopWindowBridge } from "../../../types/desktop-window";
import {
  getDockDividerLayouts,
  getDockLeafLayouts,
  isPaneInLayout,
  type DockGeometryOptions,
  type LayoutBounds,
  type ResolvedPane,
} from "../../../plugins/pane-manager";
import type { PluginRegistry } from "../../../plugins/registry";
import type { LayoutConfig } from "../../../types/config";
import { contextMenuDivider } from "../../../types/context-menu";
import {
  resolveTickerForPane,
  syncConfigActiveLayoutState,
  useAppDispatch,
  useAppSelector,
  useAppStateRef,
} from "../../../state/app/context";
import {
  selectCommandBarOpen,
  selectFocusedPaneId,
  selectLayout,
  selectStatusBarVisible,
} from "../../../state/selectors-ui";
import { useThemeColors } from "../../../theme/theme-context";
import { getPaneDisplayTitle } from "../pane/title";
import type { PaneHeaderQuickSetting } from "../pane/header";
import { getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import {
  actionMenuWidth,
  menuForPane,
  menuItemsForFallback,
} from "./menu";
import { tickerLinkMenuItems } from "./ticker-link-menu";
import {
  makeSnapGuides,
  resolveExternalDockPreview,
  resolveHoverOverlay,
} from "./drag";
import { resolveAppHeaderHeightCells } from "./chrome";
import { useShellWindowMode } from "./window-mode";
import { useShellNativeSurfaceWindowState } from "./native/surfaces";
import { ShellWindowModeOverlays } from "./window-mode/overlays";
import { ShellPaneLayers } from "./pane/layers";
import { ShellActionMenuOverlay, type ActionMenuState } from "./action-menu-overlay";
import { ShellDragOverlays } from "./drag/overlays";
import {
  useShellDragRuntimeState,
  useShellPointerRuntime,
} from "./drag/runtime";
import { useShellPaneManagementShortcuts } from "./pane/management-shortcuts";
import {
  useShellResolvedPanes,
  useShellVisibleLayout,
} from "./layout-state";
import { AuthDialogHost } from "../../../plugins/builtin/cloud/auth-dialog";
import { DeviceSignInDialogHost } from "../../../plugins/builtin/cloud/device-signin-dialog";
import { useShellPaneActions } from "./pane/actions";
import { resolvePaneFocusSourceLayout } from "./fullscreen";
import { useTransientLayout } from "../transient-layout";
import {
  resolveShellCursorOcclusionRects,
  useShellCursorOcclusionGuard,
} from "./cursor-occlusion";
import { createShare, openLiveShareUrl } from "../../../shares/api";
import { buildPaneSharePayload } from "../../../shares/pane";
import type { SharePayload } from "../../../shares/payload";

export { resolveAppHeaderHeightCells } from "./chrome";
export { buildNativeWindowState } from "./native/window-state";
export { resolvePaneManagementShortcut } from "./shortcuts";

interface ShellProps {
  pluginRegistry: PluginRegistry;
  desktopWindowBridge?: DesktopWindowBridge;
  desktopDockPreview?: DesktopDockPreviewState | null;
  commandBarNativeOccluder?: LayoutBounds | null;
}

interface TransientFocusLayoutState {
  paneId: string;
  layout: LayoutConfig;
  sourceLayoutIndex: number;
  active: boolean;
}

export function Shell({
  pluginRegistry,
  desktopWindowBridge,
  desktopDockPreview,
  commandBarNativeOccluder = null,
}: ShellProps) {
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const config = useAppSelector((state) => state.config);
  const paneState = useAppSelector((state) => state.paneState);
  const focusedPaneId = useAppSelector(selectFocusedPaneId);
  const previousFocusedPaneId = useAppSelector((state) => state.previousFocusedPaneId);
  const activePanel = useAppSelector((state) => state.activePanel);
  const commandBarOpen = useAppSelector(selectCommandBarOpen);
  const stateRef = useAppStateRef();
  const inputCaptured = useAppSelector((state) => state.inputCaptured);
  const statusBarVisible = useAppSelector(selectStatusBarVisible);
  const rendererHost = useRendererHost();
  const { setTransientLayout } = useTransientLayout();
  const uiKind = useUiHost().kind;
  const shortcutDisplayMode = getShortcutDisplayMode(uiKind);
  const { nativePaneChrome = false, nativeContextMenu, precisePointer, publicSharing, titleBarOverlay, cellHeightPx } = useUiCapabilities();
  const { showContextMenu } = useContextMenu();
  const { width, height } = useViewport();
  const shellRef = useRef<BoxRenderable | null>(null);

  const appHeaderHeight = resolveAppHeaderHeightCells({ titleBarOverlay, cellHeightPx });
  const contentHeight = Math.max(1, height - appHeaderHeight - (statusBarVisible ? 1 : 0));
  pluginRegistry.getTermSizeFn = () => ({ width, height: contentHeight });

  const layout = useAppSelector(selectLayout);
  const dialogOpen = useDialogState((dialog) => dialog.isOpen);
  const [hoveredPaneId, setHoveredPaneId] = useState<string | null>(null);
  const setHoveredPaneIfChanged = useCallback((paneId: string | null) => {
    if (commandBarOpen) return;
    setHoveredPaneId((current) => (current === paneId ? current : paneId));
  }, [commandBarOpen]);
  const [menuState, setMenuState] = useState<ActionMenuState | null>(null);
  const [transientFocusLayoutState, setTransientFocusLayoutState] = useState<TransientFocusLayoutState | null>(null);
  const transientFocusLayoutStateRef = useRef<TransientFocusLayoutState | null>(null);
  transientFocusLayoutStateRef.current = transientFocusLayoutState;
  const [hoveredMenuItemId, setHoveredMenuItemId] = useState<string | null>(null);
  const closePaneMenu = useCallback(() => {
    setMenuState(null);
    setHoveredMenuItemId(null);
  }, []);
  const overlayOpen = commandBarOpen || dialogOpen || !!menuState;
  useEffect(() => {
    if (commandBarOpen) setHoveredPaneId(null);
  }, [commandBarOpen]);

  const dragRuntime = useShellDragRuntimeState({
    contentHeight,
    throttleFloatingPreview: nativePaneChrome,
    width,
  });
  const {
    cancelActiveDrag,
    dividerPreview,
    dockPreview,
    dragCursor,
    dragFloatingRect,
    dragRef,
    hasActiveDrag,
  } = dragRuntime;

  const { disabledPaneIds, visibleLayout } = useShellVisibleLayout({
    disabledPlugins: config.disabledPlugins,
    layout,
    pluginRegistry,
  });
  const dockGeometryOptions = useMemo<DockGeometryOptions>(() => (
    nativePaneChrome ? { precise: true } : { reserveDividerGutters: true }
  ), [nativePaneChrome]);
  const bounds = useMemo<LayoutBounds>(() => ({ x: 0, y: 0, width, height: contentHeight }), [contentHeight, width]);

  const persistLayout = useCallback((nextLayout: LayoutConfig, options?: { pushHistory?: boolean; focusedPaneId?: string | null }) => {
    if (options?.pushHistory !== false) {
      dispatch({ type: "PUSH_LAYOUT_HISTORY" });
    }
    const hasFocusTarget = !!options && Object.prototype.hasOwnProperty.call(options, "focusedPaneId");
    dispatch(hasFocusTarget
      ? { type: "UPDATE_LAYOUT", layout: nextLayout, focusedPaneId: options.focusedPaneId ?? null }
      : { type: "UPDATE_LAYOUT", layout: nextLayout });
    const currentState = stateRef.current;
    scheduleConfigSave(syncConfigActiveLayoutState(
      { ...currentState.config, layout: nextLayout },
      currentState.paneState,
      hasFocusTarget ? (options.focusedPaneId ?? null) : currentState.focusedPaneId,
      currentState.activePanel,
    ));
  }, [dispatch, stateRef]);

  const focusPane = useCallback((paneId: string) => {
    dispatch({ type: "FOCUS_PANE", paneId });
  }, [dispatch]);

  const {
    activeLayout: windowModeLayout,
    nativeWindowModePanelRect,
    selectWindowModePane,
    startWindowMode,
    updateWindowModePreviewLayout,
    windowMode,
    windowModeDockMovePreview,
  } = useShellWindowMode({
    bounds,
    cancelActiveDrag,
    closePaneMenu,
    contentHeight,
    dockGeometryOptions,
    focusPane,
    focusedPaneId,
    hasActiveDrag,
    nativePaneChrome,
    persistLayout,
    pluginRegistry,
    visibleLayout,
    width,
  });
  const transientFocusActive = !windowMode && transientFocusLayoutState?.active === true;
  const activeLayout = transientFocusActive && transientFocusLayoutState
    ? transientFocusLayoutState.layout
    : windowModeLayout;
  const transientFocusPaneId = transientFocusActive ? transientFocusLayoutState?.paneId ?? null : null;

  useEffect(() => {
    if (!windowMode || !transientFocusLayoutState) return;
    transientFocusLayoutStateRef.current = null;
    setTransientFocusLayoutState(null);
  }, [transientFocusLayoutState, windowMode]);

  const {
    dockedPanes,
    paneMap,
    visibleFloatingPanes,
  } = useShellResolvedPanes({
    activeLayout,
    contentHeight,
    disabledPaneIds,
    pluginRegistry,
    width,
  });
  const cursorOcclusionRects = useMemo(() => resolveShellCursorOcclusionRects({
    contentHeight,
    dragFloatingRect,
    nativePaneChrome,
    overlayOpen,
    transientFocusActive,
    visibleFloatingPanes,
    width,
  }), [
    contentHeight,
    dragFloatingRect,
    nativePaneChrome,
    overlayOpen,
    transientFocusActive,
    visibleFloatingPanes,
    width,
  ]);
  useShellCursorOcclusionGuard({
    occlusionRects: cursorOcclusionRects,
    shellRef,
  });

  const {
    closeAllFloatingPanes,
    closeFocusedPane,
    copyFocusedPaneScreenshot,
    copyPaneScreenshot,
    gridlockVisiblePanes,
    handleFloatingClose,
    openFocusedPaneSettings,
    openPaneSettings,
    popOutFocusedPane,
    toggleFocusedPaneFloating,
  } = useShellPaneActions({
    closePaneMenu,
    contentHeight,
    desktopWindowBridge,
    focusedPaneId,
    focusPane,
    nativePaneChrome,
    paneMap,
    persistLayout,
    previousFocusedPaneId,
    pluginRegistry,
    rendererHost,
    visibleLayout,
    width,
  });
  const openLayoutGallery = useCallback(() => {
    pluginRegistry.showPane("layout-marketplace");
  }, [pluginRegistry]);
  const setTransientFocusLayout = useCallback((next: TransientFocusLayoutState | null) => {
    transientFocusLayoutStateRef.current = next;
    setTransientFocusLayoutState(next);
  }, []);
  const activateTransientFocusState = useCallback((current: TransientFocusLayoutState) => {
    closePaneMenu();
    setTransientFocusLayout({ ...current, active: true });
    const sourceLayout = config.layouts[current.sourceLayoutIndex]?.layout;
    if (
      current.sourceLayoutIndex !== config.activeLayoutIndex
      && sourceLayout
      && isPaneInLayout(sourceLayout, current.paneId)
    ) {
      dispatch({ type: "SWITCH_LAYOUT", index: current.sourceLayoutIndex });
    }
    focusPane(current.paneId);
  }, [closePaneMenu, config.activeLayoutIndex, config.layouts, dispatch, focusPane, setTransientFocusLayout]);
  const toggleFocusedPaneFullscreen = useCallback(() => {
    const current = transientFocusLayoutStateRef.current;
    if (current?.active) {
      setTransientFocusLayout(null);
      return true;
    }

    if (
      current
      && current.paneId === focusedPaneId
      && current.sourceLayoutIndex === config.activeLayoutIndex
    ) {
      activateTransientFocusState(current);
      return true;
    }

    const nextLayout = resolvePaneFocusSourceLayout(visibleLayout, focusedPaneId);
    if (!focusedPaneId || !nextLayout) {
      pluginRegistry.notify({ body: "Focus a pane to make it fullscreen", type: "info" });
      return false;
    }

    closePaneMenu();
    setTransientFocusLayout({
      paneId: focusedPaneId,
      layout: nextLayout,
      sourceLayoutIndex: config.activeLayoutIndex,
      active: true,
    });
    focusPane(focusedPaneId);
    return true;
  }, [
    activateTransientFocusState,
    closePaneMenu,
    config.activeLayoutIndex,
    focusedPaneId,
    focusPane,
    pluginRegistry,
    setTransientFocusLayout,
    visibleLayout,
  ]);
  const activateTransientFocusLayout = useCallback(() => {
    const current = transientFocusLayoutStateRef.current;
    if (!current) return;
    activateTransientFocusState(current);
  }, [activateTransientFocusState]);
  const deactivateTransientFocusLayout = useCallback(() => {
    const current = transientFocusLayoutStateRef.current;
    if (!current || !current.active) return;
    closePaneMenu();
    setTransientFocusLayout({ ...current, active: false });
  }, [closePaneMenu, setTransientFocusLayout]);
  const exitTransientFocusLayout = useCallback(() => {
    closePaneMenu();
    setTransientFocusLayout(null);
  }, [closePaneMenu, setTransientFocusLayout]);

  useEffect(() => {
    setTransientLayout(
      transientFocusLayoutState
        ? {
          id: "pane-focus",
          label: "^F Focus",
          active: transientFocusActive,
          onActivate: activateTransientFocusLayout,
          onDeactivate: deactivateTransientFocusLayout,
          onExit: exitTransientFocusLayout,
        }
        : null,
    );
    return () => setTransientLayout(null);
  }, [
    activateTransientFocusLayout,
    deactivateTransientFocusLayout,
    exitTransientFocusLayout,
    setTransientLayout,
    transientFocusActive,
    transientFocusLayoutState,
  ]);

  const dockLeafLayouts = useMemo(() => getDockLeafLayouts(activeLayout, bounds, dockGeometryOptions), [activeLayout, bounds, dockGeometryOptions]);
  const dockDividerLayouts = useMemo(() => getDockDividerLayouts(activeLayout, bounds, dockGeometryOptions), [activeLayout, bounds, dockGeometryOptions]);
  const snapGuides = useMemo(() => makeSnapGuides(width, contentHeight), [contentHeight, width]);
  const externalDockPreview = useMemo(
    () => resolveExternalDockPreview(desktopDockPreview, bounds),
    [bounds, desktopDockPreview],
  );
  const activePaneDrag = dragRef.current?.type === "pane-drag" ? dragRef.current : null;
  const activeHoverOverlay = activePaneDrag && dragCursor
    ? resolveHoverOverlay(dragCursor.x, dragCursor.y, dockLeafLayouts, activePaneDrag.paneId)
    : null;
  const effectiveDockPreview = dockPreview ?? externalDockPreview;
  useShellNativeSurfaceWindowState({
    activeHoverOverlay,
    activePaneDrag,
    appHeaderHeight,
    commandBarNativeOccluder,
    contentHeight,
    dialogOpen,
    dividerPreview,
    dockDividerLayouts,
    dockedPanes,
    dragFloatingRect,
    effectiveDockPreview,
    menuState,
    nativeWindowModePanelRect,
    visibleFloatingPanes,
    width,
    windowModeDockMovePreview,
  });

  const titleState = useMemo(
    () => ({ config, paneState }) as Parameters<typeof resolveTickerForPane>[0],
    [config, paneState],
  );
  const getPaneTitle = useCallback(
    (pane: ResolvedPane): string => getPaneDisplayTitle(titleState, pane.instance, pane.def, pluginRegistry.panes),
    [pluginRegistry.panes, titleState],
  );
  const handlePaneQuickSetting = useCallback((paneId: string, key: string, event: any) => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    focusPane(paneId);
    void pluginRegistry.togglePaneQuickSetting(paneId, key).catch((error) => {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not update pane setting.",
        type: "error",
      });
    });
  }, [focusPane, pluginRegistry]);
  const getPaneQuickSettings = useCallback((paneId: string): PaneHeaderQuickSetting[] => (
    (pluginRegistry.resolvePaneQuickSettings?.(paneId) ?? []).map((setting) => ({
      key: setting.key,
      icon: setting.icon,
      label: setting.label,
      description: setting.description,
      active: setting.value,
      onMouseDown: (event) => handlePaneQuickSetting(paneId, setting.key, event),
    }))
  ), [config, handlePaneQuickSetting, pluginRegistry]);
  const sharePane = useCallback(async (payload: Extract<SharePayload, { kind: "pane" }>) => {
    try {
      const { id } = await createShare(payload);
      await rendererHost.copyText(openLiveShareUrl(id));
      pluginRegistry.notify({ body: "Share link copied to clipboard", type: "success" });
    } catch (error) {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not share this pane.",
        type: "error",
      });
    }
  }, [pluginRegistry, rendererHost]);
  const shareFocusedPane = useCallback(() => {
    if (!publicSharing || !focusedPaneId) return false;
    const pane = paneMap.get(focusedPaneId);
    if (!pane) return false;
    const payload = buildPaneSharePayload(
      pluginRegistry,
      pane.instance,
      paneState[focusedPaneId] ?? {},
      resolveTickerForPane(titleState, focusedPaneId),
    );
    if (!payload) return false;
    void sharePane(payload);
    return true;
  }, [focusedPaneId, paneMap, paneState, pluginRegistry, publicSharing, sharePane, titleState]);

  useShellPaneManagementShortcuts({
    cancelActiveDrag,
    closeAllFloatingPanes,
    closeFocusedPane,
    copyFocusedPaneScreenshot,
    focusedPaneId,
    gridlockVisiblePanes,
    hasActiveDrag,
    inputCaptured,
    openFocusedPaneSettings,
    openLayoutGallery,
    overlayOpen,
    popOutFocusedPane,
    shareFocusedPane,
    startWindowMode,
    toggleFocusedPaneFullscreen,
    toggleFocusedPaneFloating,
  });

  const openPaneMenu = useCallback((paneId: string, rect: LayoutBounds, event?: { preventDefault?: () => void; stopPropagation?: () => void }) => {
    const pane = paneMap.get(paneId);
    if (!pane) return;
    focusPane(paneId);
    const context = {
      kind: "pane" as const,
      paneId,
      paneType: pane.instance.paneId,
      title: getPaneTitle(pane),
      floating: !!pane.floating,
    };
    const sharePayload = publicSharing
      ? buildPaneSharePayload(
          pluginRegistry,
          pane.instance,
          paneState[paneId] ?? {},
          resolveTickerForPane(titleState, paneId),
        )
      : null;
    const items = menuForPane(
      pane,
      visibleLayout,
      width,
      contentHeight,
      pluginRegistry,
      persistLayout,
      focusPane,
      openPaneSettings,
      desktopWindowBridge,
      nativePaneChrome && rendererHost.copyPngImage ? copyPaneScreenshot : undefined,
      sharePayload ? () => sharePane(sharePayload) : undefined,
      tickerLinkMenuItems({
        instance: pane.instance,
        layout: visibleLayout,
        panes: pluginRegistry.panes,
        state: titleState,
        persistLayout,
      }),
    );
    void showContextMenu(context, items, event).then((shown) => {
      if (shown) return;
      const pluginItems = pluginRegistry.getContextMenuItems?.(context) ?? [];
      const fallbackSourceItems = compactContextMenuItems([
        ...items,
        ...(items.length > 0 && pluginItems.length > 0 ? [contextMenuDivider(`${context.kind}:plugin-divider`)] : []),
        ...pluginItems,
      ]);
      const fallbackItems = menuItemsForFallback(fallbackSourceItems, shortcutDisplayMode);
      if (fallbackItems.length === 0) return;
      const menuWidth = actionMenuWidth(fallbackItems, width);
      const menuX = Math.max(0, Math.min(width - menuWidth, rect.x + Math.max(0, rect.width - menuWidth)));
      const menuY = Math.max(0, Math.min(contentHeight - 1, rect.y + 1));
      setHoveredMenuItemId(fallbackItems[0]?.id ?? null);
      setMenuState({
        paneId,
        x: menuX,
        y: menuY,
        width: menuWidth,
        items: fallbackItems,
      });
    });
  }, [contentHeight, copyPaneScreenshot, desktopWindowBridge, focusPane, getPaneTitle, nativePaneChrome, openPaneSettings, paneMap, paneState, persistLayout, pluginRegistry, publicSharing, rendererHost.copyPngImage, sharePane, shortcutDisplayMode, showContextMenu, titleState, visibleLayout, width]);

  const {
    handleFloatingCloseMouseDown,
    handleMouse,
    handleNativeDrag,
    handleNativePaneContextMenu,
    handleNativePaneMouseDown,
    handlePaneAction,
    startNativeDividerDrag,
    startNativeDockedDrag,
    startNativeFloatingDrag,
    startNativeFloatResize,
  } = useShellPointerRuntime({
    appHeaderHeight,
    bounds,
    closePaneMenu,
    contentHeight,
    dockGeometryOptions,
    dockDividerLayouts,
    dockLeafLayouts,
    dragRuntime,
    focusPane,
    focusedPaneId,
    handleFloatingClose,
    menuState,
    nativePaneChrome,
    openPaneMenu,
    paneMap,
    persistLayout,
    precisePointer,
    selectWindowModePane,
    setHoveredMenuItemId,
    setMenuState,
    snapGuides,
    transientFocusActive,
    updateWindowModePreviewLayout,
    visibleFloatingPanes,
    visibleLayout,
    width,
    windowMode,
    commandBarOpen,
  });
  const windowModeDockResizePathKey = windowMode?.focus.kind === "dock-resize"
    ? windowMode.focus.pathKey
    : null;

  return (
    <Box
      ref={shellRef}
      flexDirection="row"
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minWidth={0}
      minHeight={0}
      height={nativePaneChrome ? undefined : contentHeight}
      position={nativePaneChrome ? "relative" : undefined}
      overflow="hidden"
      {...(!nativePaneChrome
        ? {
          onMouseDown: handleMouse,
          onMouseDrag: handleMouse,
          onMouseDragEnd: handleMouse,
          onMouseUp: handleMouse,
        }
        : {})}
    >
      {/* Render nothing; give the auth commands always-mounted components with dialog access. */}
      <DeviceSignInDialogHost />
      <AuthDialogHost />
      <Box
        position="absolute"
        left={0}
        top={0}
        width={width}
        height={contentHeight}
        alignItems="center"
        justifyContent="center"
      >
        <Box flexDirection="column" alignItems="center">
          <AsciiText text="Gloomberb" font="wordmark" color={colors.textMuted} />
          <Box height={1} />
          <Text fg={colors.textDim}>Ctrl+P to get started.</Text>
        </Box>
      </Box>

      <ShellPaneLayers
        contentHeight={contentHeight}
        dividerPreview={dividerPreview}
        dockDividerLayouts={dockDividerLayouts}
        dockLeafLayouts={dockLeafLayouts}
        dragFloatingRect={dragFloatingRect}
        focusedPaneId={focusedPaneId}
        getPaneTitle={getPaneTitle}
        getPaneQuickSettings={getPaneQuickSettings}
        handleFloatingClose={handleFloatingClose}
        handleFloatingCloseMouseDown={handleFloatingCloseMouseDown}
        handleNativeDrag={handleNativeDrag}
        handleNativePaneContextMenu={handleNativePaneContextMenu}
        handleNativePaneMouseDown={handleNativePaneMouseDown}
        handlePaneAction={handlePaneAction}
        hoveredPaneId={hoveredPaneId}
        menuPaneId={menuState?.paneId ?? null}
        nativeContextMenu={nativeContextMenu}
        nativePaneChrome={nativePaneChrome}
        overlayOpen={overlayOpen}
        paneMap={paneMap}
        setHoveredPaneIfChanged={setHoveredPaneIfChanged}
        startNativeDividerDrag={startNativeDividerDrag}
        startNativeDockedDrag={startNativeDockedDrag}
        startNativeFloatingDrag={startNativeFloatingDrag}
        startNativeFloatResize={startNativeFloatResize}
        transientFocusActive={transientFocusActive}
        transientFocusPaneId={transientFocusPaneId}
        visibleFloatingPanes={visibleFloatingPanes}
        width={width}
        windowModeDockResizePathKey={windowModeDockResizePathKey}
        windowModePaneId={windowMode?.paneId ?? null}
      />

      <ShellWindowModeOverlays
        bounds={bounds}
        contentHeight={contentHeight}
        dockGeometryOptions={dockGeometryOptions}
        dockLeafLayouts={dockLeafLayouts}
        dragFloatingRect={dragFloatingRect}
        focusedPaneId={focusedPaneId}
        getPaneTitle={getPaneTitle}
        menuOpen={!!menuState}
        nativePaneChrome={nativePaneChrome}
        nativeWindowModePanelRect={nativeWindowModePanelRect}
        overlayOpen={overlayOpen}
        paneMap={paneMap}
        visibleFloatingPanes={visibleFloatingPanes}
        width={width}
        windowMode={windowMode}
        windowModeDockMovePreview={windowModeDockMovePreview}
      />

      <ShellDragOverlays
        activeHoverOverlay={activeHoverOverlay}
        activePaneDrag={activePaneDrag}
        dockPreview={dockPreview}
        dragFloatingRect={dragFloatingRect}
        effectiveDockPreview={effectiveDockPreview}
      />

      <ShellActionMenuOverlay
        menuState={menuState}
        hoveredMenuItemId={hoveredMenuItemId}
        onClose={closePaneMenu}
        onHoverItem={setHoveredMenuItemId}
      />
    </Box>
  );
}
