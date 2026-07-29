import { Box, Text, useRendererHost, useUiCapabilities } from "../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { t } from "../../i18n";
import { useShortcut, useViewport } from "../../react/input";
import { useAppDispatch, useAppSelector } from "../../state/app/context";
import type { DesktopWindowBridge } from "../../types/desktop-window";
import { findPaneInstance } from "../../types/config";
import type { PluginRegistry } from "../../plugins/registry";
import { floatingPaneBg, floatingPaneTitleBg, paneTitleText } from "../../theme/colors";
import { useThemeColors } from "../../theme/theme-context";
import { hasPaneFooterContent, PaneFooterBar, PaneFooterProvider } from "./pane/footer";
import { PaneBodyFrame, getPaneWindowAttributes } from "./pane/frame";
import { PaneContent } from "./pane/content";
import { resolvePaneBodyFrame, shouldReservePaneFooter } from "./pane/sizing";
import { getPaneDisplayTitle } from "./pane/title";
import { TITLEBAR_OVERLAY_HEIGHT_PX, getTitlebarLeadingInset } from "./titlebar-overlay";
import { WindowControls, WINDOWS_CONTROL_GROUP_WIDTH_PX } from "./window-controls";
import {
  createDoubleEscapeCloseState,
  recordDoubleEscapeClose,
  resetDoubleEscapeClose,
} from "../../utils/double-escape-close";

interface DetachedPaneShellProps {
  pluginRegistry: PluginRegistry;
  desktopWindowBridge: DesktopWindowBridge & { kind: "detached"; paneId: string };
}

function stopMouse(event?: { stopPropagation?: () => void; preventDefault?: () => void }) {
  event?.stopPropagation?.();
  event?.preventDefault?.();
}

export function DetachedPaneShell({ pluginRegistry, desktopWindowBridge }: DetachedPaneShellProps) {
  const colors = useThemeColors();
  const dispatch = useAppDispatch();
  const rendererHost = useRendererHost();
  const config = useAppSelector((state) => state.config);
  const paneState = useAppSelector((state) => state.paneState);
  const inputCaptured = useAppSelector((state) => state.inputCaptured);
  const doubleEscapeCloseRef = useRef(createDoubleEscapeCloseState());
  const [windowFocused, setWindowFocused] = useState(() => (
    typeof document === "undefined" ? true : document.hasFocus()
  ));
  const { width, height } = useViewport();
  const { cellHeightPx = 18, nativePaneChrome, titleBarOverlay, windowControls } = useUiCapabilities();
  const showWindowControls = windowControls === "windows";
  const titlebarLeadingInset = titleBarOverlay ? getTitlebarLeadingInset() : 0;
  const instance = useAppSelector((state) => findPaneInstance(state.config.layout, desktopWindowBridge.paneId) ?? null);
  const paneDef = instance ? pluginRegistry.panes.get(instance.paneId) ?? null : null;
  const hasPaneSettings = !!instance && pluginRegistry.hasPaneSettings(instance.instanceId);
  const titleState = useMemo(
    () => ({ config, paneState }) as Parameters<typeof getPaneDisplayTitle>[0],
    [config, paneState],
  );
  const title = instance && paneDef
    ? getPaneDisplayTitle(titleState, instance, paneDef)
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
        void desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId);
      }
      return;
    }

    resetDoubleEscapeClose(doubleEscapeState);
  }, { phase: "before" });

  useShortcut((event) => {
    if (event.name !== "w" || (!event.ctrl && !event.meta && !event.super)) return;
    if (inputCaptured && event.ctrl && !event.meta && !event.super) return;
    event.preventDefault();
    event.stopPropagation();
    void desktopWindowBridge.closeDetachedPane?.(desktopWindowBridge.paneId);
  });

  const startWindowDrag = useCallback(() => {
    focusPane();
    void rendererHost.startWindowDrag?.();
  }, [focusPane, rendererHost]);

  const openSettings = useCallback((event?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    stopMouse(event);
    pluginRegistry.openPaneSettingsFn(desktopWindowBridge.paneId);
  }, [desktopWindowBridge.paneId, pluginRegistry]);

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
                <Box flexGrow={1} minWidth={0} overflow="hidden">
                  <Text fg={paneTitleText(focused, true, colors)} selectable={false} data-gloom-role="pane-title">{title}</Text>
                </Box>
                {hasPaneSettings && (
                  <Text
                    fg={paneTitleText(focused, true, colors)}
                    selectable={false}
                    className="electrobun-webkit-app-region-no-drag"
                    data-gloom-role="pane-action"
                    data-gloom-interactive="true"
                    onMouseDown={openSettings}
                  >
                    {" ... "}
                  </Text>
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
