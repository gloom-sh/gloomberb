/** @jsxImportSource react */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { RendererHost, UiHost } from "../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "./input-host";
import { backendRequest } from "./backend-rpc";
import { WebDataTable } from "./data-table";
import {
  WebButton,
  WebCheckbox,
  WebDialogFrame,
  WebListView,
  WebMessageComposer,
  WebPageStackView,
  WebSegmentedControl,
  WebTextField,
} from "./desktop/controls";
import { WebPopover } from "./desktop/popover";
import { WebBox } from "./host/box";
import { WebChartSurface } from "./host/chart-surface";
import { WebInput, WebTextarea } from "./host/input";
import { WebMediaSurface } from "./host/media-surface";
import {
  NATIVE_CONTEXT_MENU_SUPPORTED,
  showDesktopContextMenu,
  startElectrobunWindowDrag,
} from "./host/native";
import { WebScrollBox } from "./host/scroll-box";
import { cleanDomProps, commonStyle } from "./host/style";
import { WebAsciiText, WebSpan, WebStrong, WebText, WebUnderline } from "./host/text";
import { WebTabs } from "./host/tabs";

function currentDesktopPlatform(): string {
  const navigatorWithUserAgentData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return [
    navigatorWithUserAgentData.userAgentData?.platform,
    navigator.platform,
    navigator.userAgent,
  ].filter((value): value is string => Boolean(value)).join(" ");
}

const DESKTOP_PLATFORM = currentDesktopPlatform();
const USES_WINDOWS_CONTROLS = !/(darwin|ipad|iphone|linux|mac)/i.test(DESKTOP_PLATFORM);
const NON_WINDOWS_DESKTOP_PLATFORMS = /^(darwin|linux|freebsd|openbsd|aix|sunos)$/i;

function usesWindowsWindowControls(desktopPlatform?: string): boolean {
  const platform = desktopPlatform?.trim();
  if (!platform) {
    return USES_WINDOWS_CONTROLS;
  }
  if (/^win/i.test(platform)) {
    return true;
  }
  if (NON_WINDOWS_DESKTOP_PLATFORMS.test(platform)) {
    return false;
  }
  return USES_WINDOWS_CONTROLS;
}

export function createWebUiHost(desktopPlatform?: string): UiHost {
  const usesWindowsControls = usesWindowsWindowControls(desktopPlatform);

  return {
    kind: "desktop-web",
    capabilities: {
      nativePaneChrome: true,
      titleBarOverlay: true,
      precisePointer: true,
      fractionalViewport: true,
      cellWidthPx: WEB_CELL_WIDTH,
      cellHeightPx: WEB_CELL_HEIGHT,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      canvasCharts: true,
      nativeContextMenu: NATIVE_CONTEXT_MENU_SUPPORTED,
      windowControls: usesWindowsControls ? "windows" : undefined,
    },
    Box: WebBox,
    Text: WebText,
    Span: WebSpan,
    Strong: WebStrong,
    Underline: WebUnderline,
    ScrollBox: WebScrollBox,
    Input: WebInput,
    Textarea: WebTextarea,
    Button: WebButton,
    Checkbox: WebCheckbox,
    Popover: WebPopover,
    TextField: WebTextField,
    MessageComposer: WebMessageComposer,
    ListView: WebListView,
    SegmentedControl: WebSegmentedControl,
    DialogFrame: WebDialogFrame,
    PageStackView: WebPageStackView,
    DataTable: WebDataTable,
    Tabs: WebTabs,
    ChartSurface: WebChartSurface,
    ImageSurface: ({ children, src, alt = "", objectFit = "contain", ...props }) => {
      const imageSrc = typeof src === "string" ? src.trim() : "";
      const [failed, setFailed] = useState(false);
      useEffect(() => setFailed(false), [imageSrc]);
      const baseStyle = commonStyle(props);
      return (
        <div
          {...cleanDomProps(props)}
          style={{
            ...baseStyle,
            overflow: baseStyle.overflow ?? "hidden",
            ...(props.style as CSSProperties | undefined),
          }}
        >
          {imageSrc && !failed ? (
            <img
              src={imageSrc}
              alt={alt}
              draggable={false}
              onError={() => setFailed(true)}
              style={{
                width: "100%",
                height: "100%",
                display: "block",
                objectFit,
              }}
            />
          ) : children as ReactNode}
        </div>
      );
    },
    MediaSurface: WebMediaSurface,
    SpinnerMark: ({ color, ...props }) => (
      <span
        {...cleanDomProps(props)}
        aria-hidden="true"
        style={{
          color,
          display: "inline-block",
          width: "1ch",
          animation: "gloom-spin 0.9s steps(8) infinite",
          ...(props.style as CSSProperties | undefined),
        }}
      >
        *
      </span>
    ),
    AsciiText: (props) => <WebAsciiText {...props} desktopPlatform={desktopPlatform} />,
  };
}

export const webUiHost: UiHost = createWebUiHost();

export const webRendererHost: RendererHost = {
  supportsNativeDesktopNotifications: true,
  requestExit() {
    void backendRequest("host.exit").catch(() => window.close());
  },
  startWindowDrag() {
    startElectrobunWindowDrag();
  },
  async controlWindow(action) {
    await backendRequest("host.windowControl", { action });
  },
  async openExternal(url) {
    await backendRequest("host.openExternal", { url });
  },
  async copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      await backendRequest("host.copyText", { text });
    }
  },
  async copyPngImage(pngBase64) {
    const bytes = Uint8Array.from(atob(pngBase64), (char) => char.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    try {
      const ClipboardItemCtor = (globalThis as typeof globalThis & {
        ClipboardItem?: new (items: Record<string, Blob>) => ClipboardItem;
      }).ClipboardItem;
      if (navigator.clipboard?.write && ClipboardItemCtor) {
        await navigator.clipboard.write([new ClipboardItemCtor({ "image/png": blob })]);
        return;
      }
    } catch {
      // Fall through to the native Electrobun clipboard bridge.
    }
    await backendRequest("host.copyPngImage", { pngBase64 });
  },
  async readText() {
    try {
      return await navigator.clipboard.readText();
    } catch {
      return await backendRequest("host.readText");
    }
  },
  notify(notification) {
    void backendRequest("host.notify", {
      title: notification.title,
      body: notification.body,
      subtitle: notification.subtitle,
      sound: notification.sound,
    }).catch(() => {});
  },
  showContextMenu: showDesktopContextMenu,
  resolveLiveStream(request) {
    return backendRequest("media.resolveLiveStream", request);
  },
};
