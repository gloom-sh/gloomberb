import { Box, Text, useActionShortcut, useContextMenu, useRendererHost, useUiCapabilities, useUiHost } from "../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { useShortcut, useViewport } from "../../react/input";
import { resolveTickerForPane, useAppDispatch, useAppSelector, usePaneAppConfig } from "../../state/app/context";
import type { DesktopWindowBridge } from "../../types/desktop-window";
import { findPaneInstance } from "../../types/config";
import { isPaneLocked, PANE_LOCK_SETTING_KEY } from "../../pane-settings";
import type { PluginRegistry } from "../../plugins/registry";
import { floatingPaneBg, floatingPaneTitleBg, paneTitleText } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { IconButton } from "../ui/icon";
import { hasPaneFooterContent, PaneFooterBar, PaneFooterKeys, PaneFooterProvider } from "./pane/footer";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneContent } from "./pane/content";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "./pane/sizing";
import { getPaneDisplayTitle } from "./pane/title";
import { TITLEBAR_OVERLAY_HEIGHT_PX, getTitlebarLeadingInset } from "./titlebar-overlay";
import { useWindowFullscreen } from "./window-fullscreen";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";
import {
  armDoubleEscapeClose,
  createDoubleEscapeCloseState,
  resetDoubleEscapeClose,
  takeDoubleEscapeClose,
} from "../../utils/double-escape-close";
import { copyLivePaneShare } from "../../shares/live";
import { buildPaneSharePayload } from "../../shares/pane";
import { contextMenuDivider, type ContextMenuItem } from "../../types/context-menu";
import { useKeybindings } from "../../app/keybindings";
import { useDialogState } from "../../ui/dialog";
import { getShortcutDisplayMode } from "../../utils/shortcut-labels";
import {
  inputCaptureAllowsPaneManagementShortcut,
  modalSurfaceOwnsKey,
  paneManagementAccelerators,
  resolvePaneManagementShortcut,
} from "./shell/shortcuts";
import { menuItemsForFallback, paneFooterMenuItems } from "./shell/menu";
import { paneMenuButtonAnchor, ShellActionMenuOverlay, type ActionMenuState } from "./shell/action-menu-overlay";
import { getPaneFooter } from "./pane/footer";

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
  const keybindings = useKeybindings();
  const accelerators = useMemo(() => paneManagementAccelerators(keybindings), [keybindings]);
  const shortcutDisplayMode = getShortcutDisplayMode(useUiHost().kind);
  const menuShortcut = useActionShortcut("pane-menu");
  const dialogOpen = useDialogState((state) => state.isOpen);
  const [menuState, setMenuState] = useState<ActionMenuState | null>(null);
  const [windowFocused, setWindowFocused] = useState(() => (
    typeof document === "undefined" ? true : document.hasFocus()
  ));
  const { width, height } = useViewport();
  const {
    cellHeightPx = 18,
    nativePaneChrome,
    publicSharing,
    titleBarOverlay,
    nativeWindowChrome = titleBarOverlay,
    windowControls,
  } = useUiCapabilities();
  const showWindowControls = nativeWindowChrome && windowControls === "windows";
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
  const tickers = useAppSelector((state) => state.tickers);
  const sharePayload = useMemo(() => instance && publicSharing
    ? buildPaneSharePayload(
        pluginRegistry,
        instance,
        paneState[instance.instanceId] ?? {},
        resolveTickerForPane(titleState, instance.instanceId),
        tickers,
      )
    : null, [instance, paneState, pluginRegistry, publicSharing, tickers, titleState]);
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
        if (!locked) void desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId);
      }
      return;
    }

    resetDoubleEscapeClose(doubleEscapeState);
  }, { phase: "before" });

  useShortcut((event) => {
    if (event.name !== "escape" && event.name !== "esc") return;
    armDoubleEscapeClose(doubleEscapeCloseRef.current, desktopWindowBridge.paneId, Date.now());
  }, { phase: "idle" });

  const closePane = useCallback(() => {
    if (locked) {
      pluginRegistry.notify({ body: "Pane is locked. Unlock it in pane settings.", type: "info" });
      return;
    }
    void desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId);
  }, [desktopWindowBridge, locked, pluginRegistry]);

  const startWindowDrag = useCallback(() => {
    focusPane();
    if (nativeWindowChrome) void rendererHost.startWindowDrag?.();
  }, [focusPane, nativeWindowChrome, rendererHost]);

  const sharePane = useCallback(async () => {
    if (!sharePayload) return;
    await copyLivePaneShare(sharePayload, {
      copyText: (text) => rendererHost.copyText(text),
      notify: (notification) => { pluginRegistry.notify(notification); },
    });
  }, [pluginRegistry, rendererHost, sharePayload]);
  useEffect(() => {
    const share = () => { void sharePane(); };
    pluginRegistry.sharePaneFn = share;
    return () => {
      if (pluginRegistry.sharePaneFn === share) pluginRegistry.sharePaneFn = () => {};
    };
  }, [pluginRegistry, sharePane]);


  const togglePaneLock = useCallback(() => {
    void pluginRegistry.applyPaneSettingValueFn(
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
    ? () => { void desktopWindowBridge.dockDetachedPane?.(desktopWindowBridge.paneId); }
    : null;

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
        onSelect: () => pluginRegistry.openPaneSettingsFn(desktopWindowBridge.paneId),
      });
    }
    if (sharePayload) {
      items.push({ id: "share-pane", label: "Share Pane", accelerator: accelerators.share, onSelect: sharePane });
    }
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
    // A native menu opens at the pointer, nowhere near the button when the
    // keyboard asked for it.
    if (options.keyboard) {
      openKitMenu(items);
      return;
    }
    void showContextMenu({
      kind: "pane",
      paneId: desktopWindowBridge.paneId,
      paneType: instance?.paneId ?? "",
      title,
      floating: true,
    }, items).then((shown) => {
      if (!shown) openKitMenu(items);
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
      if (!dialogOpen && !menuState) closePane();
      return;
    }
    if (dialogOpen || menuState) return;
    if (inputCaptured && !inputCaptureAllowsPaneManagementShortcut(shortcut, event)) return;
    let handled = true;
    switch (shortcut) {
      case "settings":
        if (hasPaneSettings) pluginRegistry.openPaneSettingsFn(desktopWindowBridge.paneId);
        else handled = false;
        break;
      case "share":
        if (sharePayload) void sharePane();
        else handled = false;
        break;
      case "toggle-floating":
        if (dockPaneRef.current) dockPaneRef.current();
        else handled = false;
        break;
      default:
        handled = false;
    }
    if (!handled) return;
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
      {(footer) => {
        const showFooter = hasPaneFooterContent(footer);
        const reserveFooter = shouldReservePaneFooter(nativePaneChrome, showFooter);
        const renderFooter = reserveFooter || showFooter;
        const headerHeightRows = titleBarOverlay ? TITLEBAR_OVERLAY_HEIGHT_PX / cellHeightPx : 1;
        const background = floatingPaneBg(focused, colors);
        const titleBackground = floatingPaneTitleBg(focused, colors);
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
            <Box
              height={1}
              width={width}
              backgroundColor={titleBackground}
              flexDirection="row"
              data-gloom-role="pane-header"
              data-titlebar-overlay={titleBarOverlay ? "true" : undefined}
              data-floating="true"
              data-focused={focused ? "true" : "false"}
              style={{ boxShadow: `0 -1px 0 ${titleBackground}, inset 0 1px 0 ${titleBackground}` }}
              onMouseDown={startWindowDrag}
            >
              <Box
                flexDirection="row"
                alignItems="center"
                flexGrow={1}
                minWidth={0}
                backgroundColor={titleBackground}
                paddingLeft={titleBarOverlay ? titlebarLeadingInset : 1}
                paddingRight={showWindowControls ? 0 : 1}
                style={{ position: "relative" }}
              >
                <Box minWidth={0} flexShrink={1} overflow="hidden">
                  <Text fg={paneTitleText(focused, true, colors)} selectable={false} data-gloom-role="pane-title">{title}</Text>
                </Box>
                {quickSettings.map((setting) => (
                  <Box
                    key={setting.key}
                    className="electrobun-webkit-app-region-no-drag"
                    data-gloom-role="pane-quick-setting"
                    data-setting-key={setting.key}
                  >
                    <IconButton
                      icon="zap"
                      label={`${setting.label}: ${setting.value ? "on" : "off"}`}
                      pressed={setting.value}
                      onPress={() => toggleQuickSetting(setting.key)}
                    />
                  </Box>
                ))}
                <Box flexGrow={1} minWidth={0} />
                {locked && (
                  <Box data-gloom-role="pane-lock">
                    <IconButton icon="lock" label="Locked: the close shortcut leaves this pane open" />
                  </Box>
                )}
                <Box className="electrobun-webkit-app-region-no-drag" data-gloom-role="pane-action">
                  <IconButton
                    icon="more"
                    label="Pane actions"
                    shortcut={menuShortcut || undefined}
                    hasPopup="menu"
                    onPress={() => openActions()}
                  />
                </Box>
                {showWindowControls ? <Box flexShrink={0} width={`${WINDOWS_CONTROL_GROUP_WIDTH_PX}px`} /> : null}
                {showWindowControls ? <WindowControls windowKind="detached" /> : null}
              </Box>
            </Box>
            <PaneBodyFrame layoutProps={bodyFrame.layoutProps} backgroundColor={background}>
              <PaneContent
                component={paneDef.component}
                paneId={instance.instanceId}
                paneType={instance.paneId}
                focused={focused}
                width={bodyWidth}
                height={bodyHeight}
              />
            </PaneBodyFrame>
            {renderFooter && <PaneFooterBar footer={footer} focused={focused} width={width} />}
            <PaneFooterKeys paneId={desktopWindowBridge.paneId} footer={footer} focused={focused} />
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
