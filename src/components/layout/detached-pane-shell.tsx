import { Box, Text, useContextMenu, useNativeRenderer, useRendererHost, useUiCapabilities, useUiHost } from "../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { useShortcut, useViewport } from "../../react/input";
import { resolveTickerForPane, useAppDispatch, useAppSelector, usePaneAppConfig } from "../../state/app/context";
import type { DesktopWindowBridge } from "../../types/desktop-window";
import { findPaneInstance } from "../../types/config";
import { isPaneLocked, PANE_LOCK_SETTING_KEY } from "../../pane-settings";
import type { PluginRegistry } from "../../plugins/registry";
import { floatingPaneBg } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { hasPaneFooterContent, PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "./pane/footer";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneContent } from "./pane/content";
import { PaneHeader } from "./pane/header";
import { PaneHeaderTabsProvider, usePaneHeaderTabsHost } from "./pane/header-tabs";
import { nativePaneHeaderRows, resolvePaneBodyFrame, shouldReservePaneFooter } from "./pane/sizing";
import { getPaneDisplayTitle } from "./pane/title";
import { TITLEBAR_OVERLAY_HEIGHT_PX, getTitlebarLeadingInset } from "./titlebar-overlay";
import { useWindowFullscreen } from "./window-fullscreen";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";
import {
  armDoubleEscapeClose,
  createDoubleEscapeCloseState,
  offerEscapeTowardClose,
  resetDoubleEscapeClose,
  takeDoubleEscapeClose,
} from "../../utils/double-escape-close";
import { contextMenuDivider, type ContextMenuItem } from "../../types/context-menu";
import { useKeybindings } from "../../app/keybindings";
import { useDialogState } from "../../ui/dialog";
import { getShortcutDisplayMode } from "../../utils/shortcut-labels";
import { fireAndForget } from "../../utils/fire-and-forget";
import { createOneShots } from "../../utils/one-shot";
import {
  inputCaptureAllowsPaneManagementShortcut,
  modalSurfaceOwnsKey,
  paneManagementAccelerators,
  resolvePaneManagementShortcut,
} from "./shell/shortcuts";
import { menuItemsForFallback, paneFooterMenuItems, REPORT_BUG_MENU_LABEL } from "./shell/menu";
import { canReportPaneBug } from "../../shares/bug-report-flow";
import { useShellPaneCapture } from "./shell/pane/capture";
import { captureStampFooter, usePaneCaptureStamp } from "./pane/capture-stamp";
import { pluginContextMenuSlot, withPluginContextMenuItems } from "../../ui/context-menu";
import { paneMenuButtonAnchor, ShellActionMenuOverlay, type ActionMenuState } from "./shell/action-menu-overlay";
import { getPaneFooter } from "./pane/footer";
import { requestPaneDocs } from "../../docs/requests";
import { DOCS_PANE_TEMPLATE_ID } from "../../docs/content";

interface DetachedPaneShellProps {
  pluginRegistry: PluginRegistry;
  desktopWindowBridge: DesktopWindowBridge & { kind: "detached"; paneId: string };
}

export function DetachedPaneShell({ pluginRegistry, desktopWindowBridge }: DetachedPaneShellProps) {
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const rendererHost = useRendererHost();
  const { showContextMenu } = useContextMenu();
  const config = usePaneAppConfig();
  const paneState = useAppSelector((state) => state.paneState);
  const inputCaptured = useAppSelector((state) => state.inputCaptured);
  const doubleEscapeCloseRef = useRef(createDoubleEscapeCloseState());
  // A key held down, or a trigger with no repeat flag, runs each action once.
  const [shots] = useState(createOneShots);
  const keybindings = useKeybindings();
  const accelerators = useMemo(() => paneManagementAccelerators(keybindings), [keybindings]);
  const shortcutDisplayMode = getShortcutDisplayMode(useUiHost().kind);
  const dialogOpen = useDialogState((state) => state.isOpen);
  const [menuState, setMenuState] = useState<ActionMenuState | null>(null);
  const [windowFocused, setWindowFocused] = useState(() => (
    typeof document === "undefined" ? true : document.hasFocus()
  ));
  const { width, height } = useViewport();
  const {
    cellHeightPx = 18,
    nativePaneChrome,
    titleBarOverlay,
    nativeWindowChrome = titleBarOverlay,
    windowControls,
  } = useUiCapabilities();
  const showWindowControls = nativeWindowChrome && windowControls === "windows";
  // The pane's primary tabs sit in the title bar, as they do in the main window.
  const { headerTabs, contextValue: headerTabsContext } = usePaneHeaderTabsHost(nativePaneChrome === true);
  const windowFullscreen = useWindowFullscreen();
  const titlebarLeadingInset = titleBarOverlay && nativeWindowChrome
    ? getTitlebarLeadingInset({ windowFullscreen })
    : 0;
  const instance = useAppSelector((state) => findPaneInstance(state.config.layout, desktopWindowBridge.paneId) ?? null);
  const locked = isPaneLocked(instance);
  const paneDef = instance ? pluginRegistry.panes.get(instance.paneId) ?? null : null;
  const hasPaneSettings = !!instance && pluginRegistry.hasPaneSettings(instance.instanceId);
  const titleState = useMemo(
    () => ({ config, paneState }) as Parameters<typeof resolveTickerForPane>[0],
    [config, paneState],
  );
  const quickSettings = instance ? pluginRegistry.resolvePaneQuickSettings(instance.instanceId) : [];
  const title = instance && paneDef
    ? getPaneDisplayTitle(titleState, instance, paneDef, pluginRegistry.panes)
    : "Detached Pane";
  // A dialog owns the keyboard while it is open. The pane stays focused under
  // its own menu, so the menu's sort and tab items still reach it; the menu
  // keeps keys from the pane below.
  const focused = windowFocused && !dialogOpen;

  const focusPane = useCallback(() => {
    setWindowFocused(true);
    dispatch({ type: "FOCUS_PANE", paneId: desktopWindowBridge.paneId });
  }, [desktopWindowBridge.paneId, dispatch]);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const handleFocus = () => {
      setWindowFocused(true);
      focusPane();
    };
    const handleBlur = () => setWindowFocused(false);

    window.addEventListener("focus", handleFocus);
    window.addEventListener("blur", handleBlur);
    if (document.hasFocus()) {
      handleFocus();
    } else {
      handleBlur();
    }

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("blur", handleBlur);
    };
  }, [focusPane]);

  useShortcut((event) => {
    const doubleEscapeState = doubleEscapeCloseRef.current;
    const isEscape = event.name === "escape" || event.name === "esc";
    if (isEscape) {
      if (takeDoubleEscapeClose(doubleEscapeState, desktopWindowBridge.paneId, Date.now())) {
        event.preventDefault();
        event.stopPropagation();
        if (!locked) fireAndForget(desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId), "desktop.closeDetachedPane");
      }
      return;
    }

    resetDoubleEscapeClose(doubleEscapeState);
  }, { phase: "before" });

  const armDoubleEscape = () => {
    armDoubleEscapeClose(doubleEscapeCloseRef.current, desktopWindowBridge.paneId, Date.now());
  };

  // A pane that uses an Esc to leave an empty field may still count it.
  useShortcut((event) => {
    if (event.name !== "escape" && event.name !== "esc") return;
    offerEscapeTowardClose(event, armDoubleEscape);
  }, { phase: "before", allowEditable: true });

  useShortcut((event) => {
    if (event.name !== "escape" && event.name !== "esc") return;
    armDoubleEscape();
  }, { phase: "idle" });

  const closePane = useCallback(() => {
    if (locked) {
      pluginRegistry.notify({ body: "Pane is locked. Unlock it in pane settings.", type: "info" });
      return;
    }
    fireAndForget(desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId), "desktop.closeDetachedPane");
  }, [desktopWindowBridge, locked, pluginRegistry]);

  const startWindowDrag = useCallback(() => {
    focusPane();
    if (nativeWindowChrome) void rendererHost.startWindowDrag?.();
  }, [focusPane, nativeWindowChrome, rendererHost]);

  const sharePane = useCallback(() => {
    pluginRegistry.sharePane(desktopWindowBridge.paneId);
  }, [desktopWindowBridge.paneId, pluginRegistry]);

  // Share takes this window's pane, as the main window's shell does.
  const nativeRenderer = useNativeRenderer();
  const paneMap = useMemo(() => new Map(instance && paneDef ? [[instance.instanceId, { instance, def: paneDef }]] : []), [instance, paneDef]);
  const closeMenu = useCallback(() => setMenuState(null), []);
  const emptyRects = useCallback(() => new Map(), []);
  useShellPaneCapture({
    appHeaderHeight: 0,
    closePaneMenu: closeMenu,
    focusedPaneId: desktopWindowBridge.paneId,
    getPaneTitle: () => title,
    layout: config.layout,
    nativePaneChrome: true,
    nativeRenderer,
    paneMap,
    pluginRegistry,
    screenRects: emptyRects,
  });
  const captureStamp = usePaneCaptureStamp(desktopWindowBridge.paneId);

  const togglePaneLock = useCallback(() => {
    void pluginRegistry.applyPaneSettingValue(
      desktopWindowBridge.paneId,
      { key: PANE_LOCK_SETTING_KEY, label: "Lock Pane", type: "toggle" },
      !locked,
    ).catch((error) => {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not update pane setting.",
        type: "error",
      });
    });
  }, [desktopWindowBridge.paneId, locked, pluginRegistry]);

  const toggleQuickSetting = useCallback((key: string) => {
    focusPane();
    void pluginRegistry.togglePaneQuickSetting(desktopWindowBridge.paneId, key).catch((error) => {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not update pane setting.",
        type: "error",
      });
    });
  }, [desktopWindowBridge.paneId, focusPane, pluginRegistry]);

  const dockPane = desktopWindowBridge.dockDetachedPane
    ? () => { fireAndForget(desktopWindowBridge.dockDetachedPane?.(desktopWindowBridge.paneId), "desktop.dockDetachedPane"); }
    : null;

  // The `?`: this window cannot open a pane, so the window's help host shows the pane's card.
  const openDocs = () => {
    requestPaneDocs(desktopWindowBridge.paneId, (id) => pluginRegistry.createPaneFromTemplate(DOCS_PANE_TEMPLATE_ID, { values: { pane: id } }));
  };

  /** The same menu as a pane in the main window, minus what a window cannot do. */
  const buildMenuItems = (): ContextMenuItem[] => {
    const items = paneFooterMenuItems(getPaneFooter(desktopWindowBridge.paneId));
    if (items.length > 0) items.push(contextMenuDivider("detached:own-actions-divider"));
    for (const setting of quickSettings) {
      items.push({
        id: `quick-setting:${setting.key}`,
        label: setting.label,
        checked: setting.value,
        onSelect: () => toggleQuickSetting(setting.key),
      });
    }
    if (quickSettings.length > 0) items.push(contextMenuDivider("detached:quick-settings-divider"));
    if (hasPaneSettings) {
      items.push({
        id: "settings",
        label: "Settings",
        accelerator: accelerators.settings,
        onSelect: () => pluginRegistry.openPaneSettings(desktopWindowBridge.paneId),
      });
    }
    items.push({ id: "pane-docs", label: "Docs", onSelect: openDocs });
    items.push({ id: "share-pane", label: "Share", accelerator: accelerators.share, onSelect: sharePane });
    // A popped-out window paints its pane's DOM, so it can always picture it.
    if (canReportPaneBug(true)) {
      items.push({ id: "report-bug", label: REPORT_BUG_MENU_LABEL, onSelect: () => pluginRegistry.reportPaneBug(desktopWindowBridge.paneId) });
    }
    items.push(pluginContextMenuSlot("pane"));
    if (dockPane) {
      items.push({ id: "dock", label: "Dock in Main Window", accelerator: accelerators.toggleFloating, onSelect: dockPane });
    }
    items.push({
      id: "toggle-pane-lock",
      // The label carries the state: the terminal menu has no checkmark column.
      label: locked ? "Unlock Pane" : "Lock Pane",
      onSelect: togglePaneLock,
    });
    items.push({ id: "close-pane", label: "Close Pane", accelerator: accelerators.close, onSelect: closePane });
    // Windows draws its own window buttons here, and a popped-out window has no
    // command bar, so the menu is their keyboard path.
    if (showWindowControls && rendererHost.controlWindow) {
      items.push(
        contextMenuDivider("detached:window-divider"),
        { id: "window-minimize", label: "Minimize Window", onSelect: () => { void rendererHost.controlWindow?.("minimize"); } },
        { id: "window-maximize", label: "Maximize Window", onSelect: () => { void rendererHost.controlWindow?.("toggle-maximize"); } },
      );
    }
    return items;
  };

  const openKitMenu = (items: ContextMenuItem[]) => {
    const entries = menuItemsForFallback(items, shortcutDisplayMode);
    if (entries.length === 0) return;
    setMenuState({
      paneId: desktopWindowBridge.paneId,
      x: 0,
      y: 0,
      width: 0,
      items: entries,
      anchor: paneMenuButtonAnchor(desktopWindowBridge.paneId),
    });
  };

  const openActions = (options: { keyboard?: boolean } = {}) => {
    focusPane();
    const items = buildMenuItems();
    const context = {
      kind: "pane" as const,
      paneId: desktopWindowBridge.paneId,
      paneType: instance?.paneId ?? "",
      title,
      floating: true,
    };
    // A native menu opens at the pointer, nowhere near the button when the
    // keyboard asked for it.
    if (options.keyboard) {
      openKitMenu(withPluginContextMenuItems(context, items, pluginRegistry));
      return;
    }
    void showContextMenu(context, items).then((shown) => {
      if (!shown) openKitMenu(withPluginContextMenuItems(context, items, pluginRegistry));
    });
  };
  const openActionsRef = useRef(openActions);
  openActionsRef.current = openActions;
  const dockPaneRef = useRef(dockPane);
  dockPaneRef.current = dockPane;

  // The open menu keeps keys from the pane, whatever mounted later.
  useShortcut((event) => {
    if (!menuState || !modalSurfaceOwnsKey(event, keybindings)) return;
    event.preventDefault();
    event.stopPropagation();
  }, { phase: "capture", scope: "detached-pane-menu", allowEditable: true, enabled: menuState !== null });

  // A pane that binds "." itself keeps it, however late it mounted.
  useShortcut((event) => {
    if (dialogOpen || menuState || inputCaptured) return;
    if (resolvePaneManagementShortcut(event, keybindings) !== "menu") return;
    event.preventDefault();
    event.stopPropagation();
    const shot = shots.get("menu");
    if (shot.refuses(event)) return;
    shot.end();
    openActionsRef.current({ keyboard: true });
  }, { phase: "idle" });

  useShortcut((event) => {
    const shortcut = resolvePaneManagementShortcut(event, keybindings);
    if (!shortcut || shortcut === "menu") return;
    if (shortcut === "close") {
      if (inputCaptured && !inputCaptureAllowsPaneManagementShortcut(shortcut, event)) return;
      // Swallowed either way, so a locked pane never falls through to the
      // window's own close accelerator.
      event.preventDefault();
      event.stopPropagation();
      const closeShot = shots.get(shortcut);
      if (!dialogOpen && !menuState && !closeShot.refuses(event)) {
        closeShot.end();
        closePane();
      }
      return;
    }
    if (dialogOpen || menuState) return;
    if (inputCaptured && !inputCaptureAllowsPaneManagementShortcut(shortcut, event)) return;
    const shot = shots.get(shortcut);
    if (shot.refuses(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    let handled = true;
    switch (shortcut) {
      case "settings":
        if (hasPaneSettings) pluginRegistry.openPaneSettings(desktopWindowBridge.paneId);
        else handled = false;
        break;
      case "share":
        sharePane();
        break;
      case "toggle-floating":
        if (dockPaneRef.current) dockPaneRef.current();
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (!handled) return;
    shot.end();
    event.preventDefault();
    event.stopPropagation();
  });

  if (!instance || !paneDef) {
    return (
      <Box flexGrow={1} alignItems="center" justifyContent="center" backgroundColor={colors.bg}>
        <Text fg={colors.textDim}>{t("Pane unavailable.")}</Text>
      </Box>
    );
  }

  return (
    <PaneFooterProvider>
      {(registeredFooter) => {
        const footer = captureStampFooter(registeredFooter, captureStamp);
        const showFooter = hasPaneFooterContent(footer);
        const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
        const renderFooter = reserveFooter || showFooter;
        const headerHeightRows = titleBarOverlay ? TITLEBAR_OVERLAY_HEIGHT_PX / cellHeightPx : nativePaneHeaderRows();
        const background = floatingPaneBg(focused, colors);
        const bodyFrame = resolvePaneBodyFrame({
          width,
          height,
          nativePaneChrome,
          footerVisible: renderFooter,
          reserveFooter,
          headerRows: headerHeightRows,
        });
        const bodyWidth = bodyFrame.width ?? 1;
        const bodyHeight = bodyFrame.height ?? 1;

        return (
          <Box
            flexDirection="column"
            flexGrow={1}
            width={width}
            height={height}
            backgroundColor={background}
            {...getPaneWindowAttributes({
              role: "detached-pane-window",
              paneId: desktopWindowBridge.paneId,
              focused,
            })}
            onMouseDown={focusPane}
          >
            <PaneHeader
              title={title}
              width={width}
              focused={focused}
              floating
              locked={locked}
              showActions
              quickSettings={quickSettings.map((setting) => ({
                key: setting.key,
                icon: setting.icon,
                label: setting.label,
                description: setting.description,
                active: setting.value,
                onMouseDown: () => toggleQuickSetting(setting.key),
              }))}
              tabs={headerTabs}
              titleBar={{
                rows: headerHeightRows,
                overlay: titleBarOverlay === true,
                leadingInset: titlebarLeadingInset,
                trailing: showWindowControls ? (
                  <>
                    <Box flexShrink={0} width={`${WINDOWS_CONTROL_GROUP_WIDTH_PX}px`} />
                    <WindowControls windowKind="detached" />
                  </>
                ) : null,
              }}
              onHeaderMouseDown={startWindowDrag}
              onActionMouseDown={() => openActions()}
              onHelpMouseDown={openDocs}
            />
            <PaneBodyFrame layoutProps={bodyFrame.layoutProps} backgroundColor={background}>
              <PaneHeaderTabsProvider value={headerTabsContext}>
                <PaneContent
                  component={paneDef.component}
                  paneId={instance.instanceId}
                  paneType={instance.paneId}
                  title={title}
                  focused={focused}
                  width={bodyWidth}
                  height={bodyHeight}
                  closePane={closePane}
                />
              </PaneHeaderTabsProvider>
            </PaneBodyFrame>
            {renderFooter && <PaneFooterBar footer={footer} focused={focused} width={width} />}
            <PaneFooterKeys paneId={desktopWindowBridge.paneId} footer={registeredFooter} focused={focused} />
            <ShellActionMenuOverlay
              menuState={menuState}
              hoveredMenuItemId={null}
              onClose={() => setMenuState(null)}
              onHoverItem={() => {}}
            />
          </Box>
        );
      }}
    </PaneFooterProvider>
  );
}
