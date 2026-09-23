import { Box, Text, useContextMenu, useRendererHost, useUiCapabilities } from "../../ui";
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
import { hasPaneFooterContent, PaneFooterBar, PaneFooterProvider } from "./pane/footer";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneContent } from "./pane/content";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "./pane/sizing";
import { getPaneDisplayTitle } from "./pane/title";
import { TITLEBAR_OVERLAY_HEIGHT_PX, getTitlebarLeadingInset } from "./titlebar-overlay";
import { useWindowFullscreen } from "./window-fullscreen";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";
import {
  createDoubleEscapeCloseState,
  recordDoubleEscapeClose,
  resetDoubleEscapeClose,
} from "../../utils/double-escape-close";
import { copyLivePaneShare } from "../../shares/live";
import { buildPaneSharePayload } from "../../shares/pane";
import type { ContextMenuItem } from "../../types/context-menu";
import {
  PANE_MANAGEMENT_ACCELERATORS,
  resolvePaneManagementShortcut,
} from "./shell/shortcuts";

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
  const focused = windowFocused;

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
      if (recordDoubleEscapeClose(doubleEscapeState, desktopWindowBridge.paneId, Date.now())) {
        event.preventDefault();
        event.stopPropagation();
        if (!locked) void desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId);
      }
      return;
    }

    resetDoubleEscapeClose(doubleEscapeState);
  }, { phase: "before" });

  useShortcut((event) => {
    if (event.name !== "w" || (!event.ctrl && !event.meta && !event.super)) return;
    if (inputCaptured && event.ctrl && !event.meta && !event.super) return;
    // Swallowed either way, so a locked pane never falls through to the
    // window's own close accelerator.
    event.preventDefault();
    event.stopPropagation();
    if (locked) {
      pluginRegistry.notify({ body: "Pane is locked. Unlock it in pane settings.", type: "info" });
      return;
    }
    void desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId);
  });

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

  useShortcut((event) => {
    if (resolvePaneManagementShortcut(event) !== "share" || !sharePayload) return;
    if (inputCaptured && event.ctrl && !event.meta && !event.super) return;
    event.preventDefault();
    event.stopPropagation();
    void sharePane();
  });

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

  const openActions = useCallback(() => {
    focusPane();
    const items: ContextMenuItem[] = [];
    if (hasPaneSettings) {
      items.push({
        id: "settings",
        label: "Settings",
        onSelect: () => pluginRegistry.openPaneSettingsFn(desktopWindowBridge.paneId),
      });
    }
    if (sharePayload) items.push({
      id: "share-pane",
      label: "Share Pane",
      accelerator: PANE_MANAGEMENT_ACCELERATORS.share,
      onSelect: sharePane,
    });
    items.push({
      id: "toggle-pane-lock",
      // The label carries the state: the terminal menu has no checkmark column.
      label: locked ? "Unlock Pane" : "Lock Pane",
      onSelect: togglePaneLock,
    });
    void showContextMenu({
      kind: "pane",
      paneId: desktopWindowBridge.paneId,
      paneType: instance?.paneId ?? "",
      title,
      floating: true,
    }, items).then((shown) => {
      if (!shown && hasPaneSettings) pluginRegistry.openPaneSettingsFn(desktopWindowBridge.paneId);
      else if (!shown && sharePayload) void sharePane();
    });
  }, [desktopWindowBridge.paneId, focusPane, hasPaneSettings, instance?.paneId, locked, pluginRegistry, sharePane, sharePayload, showContextMenu, title, togglePaneLock]);
  const toggleQuickSetting = useCallback((key: string) => {
    focusPane();
    void pluginRegistry.togglePaneQuickSetting(desktopWindowBridge.paneId, key).catch((error) => {
      pluginRegistry.notify({
        body: error instanceof Error ? error.message : "Could not update pane setting.",
        type: "error",
      });
    });
  }, [desktopWindowBridge.paneId, focusPane, pluginRegistry]);

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
                {(hasPaneSettings || sharePayload) && (
                  <Box className="electrobun-webkit-app-region-no-drag" data-gloom-role="pane-action">
                    <IconButton icon="more" label="Pane actions" onPress={openActions} />
                  </Box>
                )}
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
          </Box>
        );
      }}
    </PaneFooterProvider>
  );
}
