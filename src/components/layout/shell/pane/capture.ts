import { useCallback, useEffect, useRef, useState } from "react";
import { createOneShot } from "../../../../utils/one-shot";
import type { LayoutBounds, ResolvedPane } from "../../../../layout/pane-manager";
import type { PluginRegistry } from "../../../../plugins/registry";
import { paneScreenshotScale, PANE_SCREENSHOT_MIN_WIDTH } from "../../../../remote/pane-screenshot";
import { base64Bytes, formatCaptureStamp, type PaneImageCapture } from "../../../../shares/pane-image";
import { capturedPersonalData, panePersonalData } from "../../../../shares/personal-pane";
import { resolveTickerForPane, useAppStateRef } from "../../../../state/app/context";
import { pinnedTabTime } from "../../../../state/app/tab-cursor";
import type { LayoutConfig } from "../../../../types/config";
import { useRendererHost, useUiCapabilities, type NativeRendererHost } from "../../../../ui";
import { buildPaneSharePayload } from "../../../../shares/pane";
import { preparePaneShare } from "../../../../shares/prepare";
import { sharePaneLink, type PaneShareView } from "../../../../shares/flow";
import { reportPaneBug } from "../../../../shares/bug-report-flow";
import { useDialog } from "../../../../ui/dialog";
import { capturePaneImage as paintPaneImage } from "../../../../utils/dom-screenshot";
import { setPaneCaptureStamp } from "../../pane/capture-stamp";

/** Under the chat's 5 MB image limit with room to spare; a larger paint is shrunk to fit. */
const PANE_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** How long the terminal gets to draw the footer as a status line (a frame or two). */
const TERMINAL_SETTLE_MS = 120;

function nextFrames(count: number): Promise<void> {
  if (typeof requestAnimationFrame !== "function") return new Promise((resolve) => setTimeout(resolve, 32 * count));
  return new Promise((resolve) => {
    const step = (left: number) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
    step(count);
  });
}

interface UseShellPaneCaptureOptions {
  appHeaderHeight: number;
  closePaneMenu: () => void;
  focusedPaneId: string | null;
  getPaneTitle: (pane: ResolvedPane) => string;
  /** The layout the panes are in, for their `personalData` rules. */
  layout: LayoutConfig;
  nativePaneChrome: boolean;
  nativeRenderer: NativeRendererHost;
  paneMap: Map<string, ResolvedPane>;
  pluginRegistry: PluginRegistry;
  /** Where each visible pane sits in the shell, fullscreen and transient focus applied. */
  screenRects: () => Map<string, LayoutBounds>;
}

/**
 * Binds Share, which copies a pane's link, and Report a Bug, which posts its
 * picture, with the `capturePaneImage` and `promptDialog` they are built on.
 * The desktop and the web paint the pane's DOM; the terminal draws the cells
 * it shows, kitty charts included.
 */
export function useShellPaneCapture(options: UseShellPaneCaptureOptions): void {
  const { pluginRegistry } = options;
  const dialog = useDialog();
  // Shared by Share and Report a Bug from a menu, command, key or plugin call,
  // including triggers without a repeat flag: one capture flow at a time.
  const [captureOnce] = useState(createOneShot);
  const { publicSharing } = useUiCapabilities();
  const rendererHost = useRendererHost();
  const stateRef = useAppStateRef();
  const latest = useRef(options);
  latest.current = options;

  // Share reads the pane's own settings and personal data, not what is drawn over it.
  const readShareView = useCallback(async (paneId: string): Promise<PaneShareView> => {
    if (!latest.current.paneMap.has(paneId)) throw new Error("Focus a pane to share it.");
    latest.current.closePaneMenu();
    await preparePaneShare(paneId);
    // React state/settings flushed by the pane must land before building the link.
    await nextFrames(2);
    const current = latest.current;
    const pane = current.paneMap.get(paneId);
    if (!pane) throw new Error("Focus a pane to share it.");
    const state = stateRef.current;
    return {
      sharePayload: publicSharing ? buildPaneSharePayload(
        pluginRegistry,
        pane.instance,
        state.paneState[paneId] ?? {},
        resolveTickerForPane(state, paneId),
        state.tickers,
        pinnedTabTime(state),
      ) : null,
      personalData: panePersonalData({ registry: current.pluginRegistry, state, layout: current.layout, pane }),
    };
  }, [pluginRegistry, publicSharing, stateRef]);

  const capture = useCallback(async (requestedPaneId?: string): Promise<PaneImageCapture> => {
    const current = latest.current;
    const paneId = requestedPaneId ?? current.focusedPaneId;
    const pane = paneId ? current.paneMap.get(paneId) : undefined;
    if (!paneId || !pane) throw new Error("Focus a pane to share it.");
    current.closePaneMenu();
    await preparePaneShare(paneId);
    // React state/settings flushed by the pane must land before the picture.
    await nextFrames(2);
    const capturedAt = new Date();
    setPaneCaptureStamp(paneId, formatCaptureStamp(capturedAt));
    try {
      let image: Pick<PaneImageCapture, "png" | "width" | "height" | "pixels" | "cells">;
      // The terminal's picture is the screen's cells, so it shows whatever is drawn over the pane.
      let drawn: Map<string, LayoutBounds> | null = null;
      if (current.nativePaneChrome) {
        await nextFrames(2);
        const shot = await paintPaneImage({
          instanceId: paneId,
          scaleFor: (screen) => paneScreenshotScale(screen),
          maxBytes: PANE_IMAGE_MAX_BYTES,
          minWidth: PANE_SCREENSHOT_MIN_WIDTH,
        });
        image = { png: base64Bytes(shot.pngBase64), width: shot.width, height: shot.height };
      } else {
        drawn = current.screenRects();
        const rect = drawn.get(paneId);
        if (!rect || !current.nativeRenderer.capturePaneImage) {
          throw new Error("Show the pane on screen to share it.");
        }
        current.nativeRenderer.requestRender();
        await new Promise((resolve) => setTimeout(resolve, TERMINAL_SETTLE_MS));
        image = await current.nativeRenderer.capturePaneImage({
          x: rect.x,
          y: rect.y + current.appHeaderHeight,
          width: rect.width,
          height: rect.height,
        });
      }
      return {
        paneId,
        paneType: pane.instance.paneId,
        title: current.getPaneTitle(pane),
        capturedAt: capturedAt.toISOString(),
        personalData: capturedPersonalData({
          registry: current.pluginRegistry,
          state: stateRef.current,
          layout: current.layout,
          paneId,
          panes: current.paneMap,
          drawn,
        }),
        ...image,
      };
    } finally {
      setPaneCaptureStamp(paneId, null);
    }
  }, [stateRef]);

  useEffect(() => pluginRegistry.bindHost({
    sharePane: (requestedPaneId) => {
      const paneId = requestedPaneId ?? latest.current.focusedPaneId;
      if (!paneId || captureOnce.refuses()) return;
      captureOnce.start();
      // Let a menu/command close first. The flow also refuses a second run
      // until the link is copied, even beyond the cooldown's timeout.
      setTimeout(() => {
        void sharePaneLink({
          notify: (notification) => pluginRegistry.notify(notification),
          promptDialog: (prompt) => dialog.prompt(prompt),
          copyText: (text) => rendererHost.copyText(text),
          readShareView,
        }, paneId).finally(() => captureOnce.end());
      }, 0);
    },
    reportPaneBug: (requestedPaneId) => {
      const paneId = requestedPaneId ?? latest.current.focusedPaneId;
      if (!paneId || captureOnce.refuses()) return;
      captureOnce.start();
      // After the menu that chose it has closed.
      setTimeout(() => {
        void reportPaneBug(pluginRegistry, paneId).finally(() => captureOnce.end());
      }, 0);
    },
    capturePaneImage: capture,
    promptDialog: (prompt) => dialog.prompt(prompt),
  }), [capture, captureOnce, dialog, pluginRegistry, readShareView, rendererHost]);
}
