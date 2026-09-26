import { AsciiText, Box, Text, compactContextMenuItems, useContextMenu, useUiHost, type BoxRenderable } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRendererHost, useUiCapabilities } from "../../../ui";
import { useShortcut, useViewport } from "../../../react/input";
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
import { useThemeColors } from "../../../theme/theme-context";
import { tf } from "../../../i18n";
import { getPaneDisplayTitle } from "../pane/title";
import type { PaneHeaderQuickSetting } from "../pane/header";
import { getPaneFooter } from "../pane/footer";
import { getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { formatAdvertisedChord, useKeybindings } from "../../../app/keybindings";
import { modalSurfaceOwnsKey, paneManagementAccelerators } from "./shortcuts";
import {
  actionMenuWidth,
  menuForPane,
  paneFooterMenuItems,
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
import { paneMenuButtonAnchor, ShellActionMenuOverlay, type ActionMenuState } from "./action-menu-overlay";
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
import { FeedbackDialogHost } from "../../feedback-dialog";
import { useShellPaneActions } from "./pane/actions";
import { resolvePaneFocusSourceLayout } from "./fullscreen";
import { useTransientLayout } from "../transient-layout";
import {
  resolveShellCursorOcclusionRects,
  useShellCursorOcclusionGuard,
} from "./cursor-occlusion";
import { copyLivePaneShare } from "../../../shares/live";
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
  const focusedPaneId = useAppSelector((state) => state.focusedPaneId);
  const previousFocusedPaneId = useAppSelector((state) => state.previousFocusedPaneId);
  const activePanel = useAppSelector((state) => state.activePanel);
  const commandBarOpen = useAppSelector((state) => state.commandBarOpen);
  const stateRef = useAppStateRef();
  const inputCaptured = useAppSelector((state) => state.inputCaptured);
  const statusBarVisible = useAppSelector((state) => state.statusBarVisible);
  const rendererHost = useRendererHost();
  const { setTransientLayout } = useTransientLayout();
  const uiKind = useUiHost().kind;
  const shortcutDisplayMode = getShortcutDisplayMode(uiKind);
  const keybindings = useKeybindings();
  const paneAccelerators = useMemo(() => paneManagementAccelerators(keybindings), [keybindings]);
  const { nativePaneChrome = false, nativeContextMenu, precisePointer, publicSharing, titleBarOverlay, cellHeightPx } = useUiCapabilities();
  const { showContextMenu } = useContextMenu();
  const { width, height } = useViewport();
  const shellRef = useRef<BoxRenderable | null>(null);

  const appHeaderHeight = resolveAppHeaderHeightCells({ titleBarOverlay, cellHeightPx });
  const contentHeight = Math.max(1, height - appHeaderHeight - (statusBarVisible ? 1 : 0));
  pluginRegistry.getTermSizeFn = () => ({ width, height: contentHeight });

  const layout = useAppSelector((state) => state.config.layout);
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
  const hoveredMenuItemIdRef = useRef(hoveredMenuItemId);
  hoveredMenuItemIdRef.current = hoveredMenuItemId;
  const menuStateRef = useRef(menuState);
  menuStateRef.current = menuState;
  // The desktop menu closes on the press outside it, which re-renders before
  // the menu button's own handler runs; remembering the close lets that same
  // press on the button act as a toggle instead of reopening the menu.
  const lastMenuCloseRef = useRef<{ paneId: string; at: number } | null>(null);
  const closePaneMenu = useCallback(() => {
    const open = menuStateRef.current;
    if (open) lastMenuCloseRef.current = { paneId: open.paneId, at: Date.now() };
    // Keys in the same burst must see the menu closed at once.
    menuStateRef.current = null;
    hoveredMenuItemIdRef.current = null;
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
    nativePaneChrome ? {
      precise: true,
      // A whole text row overlaps the next pane's header buttons. Keep the
      // visible divider centered and share its smaller hit rect with the host.
      dividerSize: { horizontal: 1, vertical: Math.min(1, 8 / (cellHeightPx ?? 18)) },
    } : { reserveDividerGutters: true }
  ), [nativePaneChrome, cellHeightPx]);
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
    canExportPaneCsv,
    closeAllFloatingPanes,
    closeFocusedPane,
    copyFocusedPaneScreenshot,
    copyPaneScreenshot,
    exportFocusedPaneCsv,
    exportPaneCsv,
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
  /** Fullscreen for a given pane: the focused one from the key, the menu's own from its item. */
  const togglePaneFullscreen = useCallback((paneId: string | null) => {
    const current = transientFocusLayoutStateRef.current;
    if (current?.active) {
      setTransientFocusLayout(null);
      return true;
    }

    if (
      current
      && current.paneId === paneId
      && current.sourceLayoutIndex === config.activeLayoutIndex
    ) {
      activateTransientFocusState(current);
      return true;
    }

    const nextLayout = resolvePaneFocusSourceLayout(visibleLayout, paneId);
    if (!paneId || !nextLayout) {
      pluginRegistry.notify({ body: "Focus a pane to make it fullscreen", type: "info" });
      return false;
    }

    closePaneMenu();
    setTransientFocusLayout({
      paneId,
      layout: nextLayout,
      sourceLayoutIndex: config.activeLayoutIndex,
      active: true,
    });
    focusPane(paneId);
    return true;
  }, [
    activateTransientFocusState,
    closePaneMenu,
    config.activeLayoutIndex,
    focusPane,
    pluginRegistry,
    setTransientFocusLayout,
    visibleLayout,
  ]);
  const toggleFocusedPaneFullscreen = useCallback(
    () => togglePaneFullscreen(focusedPaneId),
    [focusedPaneId, togglePaneFullscreen],
  );
  useEffect(() => {
    pluginRegistry.togglePaneFullscreenFn = togglePaneFullscreen;
    return () => {
      if (pluginRegistry.togglePaneFullscreenFn === togglePaneFullscreen) pluginRegistry.togglePaneFullscreenFn = () => false;
    };
  }, [pluginRegistry, togglePaneFullscreen]);
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

  // Fullscreen shows one pane. When focus or the layout moves anywhere else
  // (Tab, a layout switch, a pane opened from the command bar), leave it, so
  // the keyboard never lands on a pane that is not on screen.
  useEffect(() => {
    const current = transientFocusLayoutStateRef.current;
    if (!current?.active) return;
    if (focusedPaneId && focusedPaneId !== current.paneId) setTransientFocusLayout(null);
    else if (config.activeLayoutIndex !== current.sourceLayoutIndex) setTransientFocusLayout(null);
  }, [config.activeLayoutIndex, focusedPaneId, setTransientFocusLayout]);

  useEffect(() => {
    setTransientLayout(
      transientFocusLayoutState
        ? {
          id: "pane-focus",
          label: "Focus",
          shortcutActionId: "pane-fullscreen",
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
  const sharePane = useCallback((payload: Extract<SharePayload, { kind: "pane" }>) => (
    copyLivePaneShare(payload, {
      copyText: (text) => rendererHost.copyText(text),
      notify: (notification) => { pluginRegistry.notify(notification); },
    })
  ), [pluginRegistry, rendererHost]);
  const sharePaneById = useCallback((paneId: string) => {
    if (!publicSharing) return false;
    const pane = paneMap.get(paneId);
    if (!pane) return false;
    const state = stateRef.current;
    const payload = buildPaneSharePayload(
      pluginRegistry,
      pane.instance,
      state.paneState[paneId] ?? {},
      resolveTickerForPane(state, paneId),
      state.tickers,
    );
    if (!payload) {
      pluginRegistry.notify({ body: "This pane cannot be shared.", type: "error" });
      return false;
    }
    void sharePane(payload);
    return true;
  }, [paneMap, pluginRegistry, publicSharing, sharePane, stateRef]);
  const shareFocusedPane = useCallback(() => (
    focusedPaneId ? sharePaneById(focusedPaneId) : false
  ), [focusedPaneId, sharePaneById]);
  // Pane-level share hints (chart, news) go through the same live hand-off as
  // the shell shortcut and the pane menu.
  useEffect(() => {
    const share = (paneId?: string) => {
      const target = paneId ?? stateRef.current.focusedPaneId;
      if (target) sharePaneById(target);
    };
    pluginRegistry.sharePaneFn = share;
    return () => {
      if (pluginRegistry.sharePaneFn === share) pluginRegistry.sharePaneFn = () => {};
    };
  }, [pluginRegistry, sharePaneById, stateRef]);

  const openPaneMenuRef = useRef<((paneId: string, rect: LayoutBounds, event?: undefined, options?: { keyboard?: boolean }) => void) | null>(null);
  const openFocusedPaneMenu = useCallback(() => {
    if (!focusedPaneId || windowMode) return false;
    const rect = transientFocusActive && transientFocusPaneId === focusedPaneId
      ? { x: 0, y: 0, width, height: contentHeight }
      : dockLeafLayouts.find((leaf) => leaf.instanceId === focusedPaneId)?.rect
        ?? visibleFloatingPanes.find(({ pane }) => pane.instance.instanceId === focusedPaneId)?.rect;
    if (!rect || !openPaneMenuRef.current) return false;
    openPaneMenuRef.current(focusedPaneId, rect, undefined, { keyboard: true });
    return true;
  }, [contentHeight, dockLeafLayouts, focusedPaneId, transientFocusActive, transientFocusPaneId, visibleFloatingPanes, width, windowMode]);

  useShellPaneManagementShortcuts({
    cancelActiveDrag,
    closeAllFloatingPanes,
    closeFocusedPane,
    copyFocusedPaneScreenshot,
    exportFocusedPaneCsv,
    focusedPaneId,
    gridlockVisiblePanes,
    hasActiveDrag,
    inputCaptured,
    openFocusedPaneMenu,
    openFocusedPaneSettings,
    openLayoutGallery,
    overlayOpen,
    popOutFocusedPane,
    shareFocusedPane,
    startWindowMode,
    toggleFocusedPaneFullscreen,
    toggleFocusedPaneFloating,
  });

  const openPaneMenu = useCallback((
    paneId: string,
    rect: LayoutBounds,
    event?: { preventDefault?: () => void; stopPropagation?: () => void; target?: unknown; pixelX?: number; pixelY?: number },
    options: { keyboard?: boolean } = {},
  ) => {
    const pane = paneMap.get(paneId);
    if (!pane) return;
    // A second press on the same pane's menu button closes it.
    if (menuStateRef.current?.paneId === paneId) {
      closePaneMenu();
      return;
    }
    const lastClose = lastMenuCloseRef.current;
    if (lastClose?.paneId === paneId && Date.now() - lastClose.at < 250) return;
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
          stateRef.current.tickers,
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
      canExportPaneCsv(paneId) ? exportPaneCsv : undefined,
      paneAccelerators,
      (pluginRegistry.resolvePaneQuickSettings?.(paneId) ?? []).map((setting) => ({
        key: setting.key,
        label: setting.label,
        active: setting.value,
        toggle: () => handlePaneQuickSetting(paneId, setting.key, undefined),
      })),
      {
        active: transientFocusLayoutStateRef.current?.active === true && transientFocusLayoutStateRef.current.paneId === paneId,
        toggle: () => { togglePaneFullscreen(paneId); },
      },
      paneFooterMenuItems(getPaneFooter(paneId)),
    );
    const showKitMenu = () => {
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
      // Under the pane's header, or higher when that leaves the menu no room.
      const menuY = Math.max(0, Math.min(rect.y + 1, contentHeight - 2 - fallbackItems.length, contentHeight - 3));
      const firstId = fallbackItems.find((item) => !item.divider)?.id ?? null;
      const nextMenu: ActionMenuState = {
        paneId,
        x: menuX,
        y: menuY,
        width: menuWidth,
        maxRows: Math.max(1, contentHeight - menuY - 2),
        items: fallbackItems,
        anchor: nativePaneChrome
          ? (options.keyboard ? paneMenuButtonAnchor(paneId) : paneMenuAnchor(event))
          : undefined,
      };
      // Keys that arrive in the same burst as the one that opened it go to the menu.
      menuStateRef.current = nextMenu;
      hoveredMenuItemIdRef.current = firstId;
      setHoveredMenuItemId(firstId);
      setMenuState(nextMenu);
    };
    // A native menu opens at the pointer, which is nowhere near the pane when
    // the keyboard asked for it; the kit menu opens under the pane's button.
    if (options.keyboard) {
      showKitMenu();
      return;
    }
    void showContextMenu(context, items, event).then((shown) => {
      if (!shown) showKitMenu();
    });
  }, [canExportPaneCsv, closePaneMenu, contentHeight, copyPaneScreenshot, desktopWindowBridge, exportPaneCsv, focusPane, getPaneTitle, handlePaneQuickSetting, nativePaneChrome, togglePaneFullscreen, openPaneSettings, paneAccelerators, paneMap, paneState, persistLayout, pluginRegistry, publicSharing, rendererHost.copyPngImage, sharePane, shortcutDisplayMode, showContextMenu, titleState, visibleLayout, width]);
  openPaneMenuRef.current = openPaneMenu;

  // The open pane menu owns the keyboard, ahead of any pane however late it
  // mounted, and over a text field it was opened from. The desktop kit menu
  // moves and chooses on its own; the terminal menu is driven here.
  useShortcut((event) => {
    const menu = menuStateRef.current;
    if (!menu || !modalSurfaceOwnsKey(event, keybindings)) return;
    event.preventDefault();
    event.stopPropagation();
    if (nativePaneChrome) return;
    const name = event.name;
    if (name === "escape") {
      closePaneMenu();
      return;
    }
    const choices = menu.items.filter((item) => !item.divider);
    const index = Math.max(0, choices.findIndex((item) => item.id === hoveredMenuItemIdRef.current));
    const last = choices.length - 1;
    let next: number | null = null;
    if (name === "down" || name === "j" || (name === "tab" && !event.shift)) next = index >= last ? 0 : index + 1;
    else if (name === "up" || name === "k" || (name === "tab" && event.shift)) next = index <= 0 ? last : index - 1;
    else if (name === "home" || name === "pageup") next = 0;
    else if (name === "end" || name === "pagedown") next = last;
    if (next !== null) {
      const id = choices[next]?.id ?? null;
      hoveredMenuItemIdRef.current = id;
      setHoveredMenuItemId(id);
      return;
    }
    if (name === "return" || name === "enter" || name === "space") {
      const item = choices[index];
      closePaneMenu();
      item?.action();
    }
  }, { phase: "capture", scope: "pane-menu", allowEditable: true });

  // A menu whose pane went away (closed from inside it, a layout switch) closes too.
  useEffect(() => {
    if (menuState && !paneMap.has(menuState.paneId)) closePaneMenu();
  }, [closePaneMenu, menuState, paneMap]);

  // In fullscreen the pointer only ever meets the one pane on screen: hit
  // testing the tiled rects behind it would focus a pane nobody can see.
  const fullscreenRect = useMemo(() => ({ x: 0, y: 0, width, height: contentHeight }), [contentHeight, width]);
  const pointerDockLeafLayouts = useMemo(() => (
    transientFocusActive
      ? dockLeafLayouts.filter((leaf) => leaf.instanceId === transientFocusPaneId).map((leaf) => ({ ...leaf, rect: fullscreenRect }))
      : dockLeafLayouts
  ), [dockLeafLayouts, fullscreenRect, transientFocusActive, transientFocusPaneId]);
  const pointerFloatingPanes = useMemo(() => (
    transientFocusActive
      ? visibleFloatingPanes.filter(({ pane }) => pane.instance.instanceId === transientFocusPaneId).map((entry) => ({ ...entry, rect: fullscreenRect }))
      : visibleFloatingPanes
  ), [fullscreenRect, transientFocusActive, transientFocusPaneId, visibleFloatingPanes]);
  const pointerDividerLayouts = transientFocusActive ? [] : dockDividerLayouts;

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
    dockDividerLayouts: pointerDividerLayouts,
    dockLeafLayouts: pointerDockLeafLayouts,
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
    visibleFloatingPanes: pointerFloatingPanes,
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
      <FeedbackDialogHost />
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
          <Text fg={colors.textDim}>
            {tf("{shortcut} to get started.", { shortcut: formatAdvertisedChord(keybindings, "command-bar", shortcutDisplayMode) })}
          </Text>
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

/**
 * Desktop menu anchor: the bottom-right of the pane's `...` button when that is
 * what was pressed, otherwise the pointer (a right-click on the title bar).
 */
function paneMenuAnchor(event?: { target?: unknown; pixelX?: number; pixelY?: number }): ActionMenuState["anchor"] {
  const target = event?.target as { closest?: (selector: string) => { getBoundingClientRect(): { right: number; bottom: number } } | null } | undefined;
  const button = target?.closest?.("[data-gloom-role=pane-action]");
  if (button) {
    const rect = button.getBoundingClientRect();
    return { x: rect.right, y: rect.bottom, placement: "bottom-end" };
  }
  if (typeof event?.pixelX === "number" && typeof event.pixelY === "number") {
    return { x: event.pixelX, y: event.pixelY, placement: "bottom-start" };
  }
  return undefined;
}
