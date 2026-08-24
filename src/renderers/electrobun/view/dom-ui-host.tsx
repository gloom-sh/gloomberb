/** @jsxImportSource react */
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { UiHost } from "../../../ui/host";
import { WEB_CELL_HEIGHT, WEB_CELL_WIDTH } from "./input-host";
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
  if (!platform) return USES_WINDOWS_CONTROLS;
  if (/^win/i.test(platform)) return true;
  if (NON_WINDOWS_DESKTOP_PLATFORMS.test(platform)) return false;
  return USES_WINDOWS_CONTROLS;
}

export function createDomUiHost(
  desktopPlatform?: string,
  options: {
    nativeContextMenu?: boolean;
    titleBarOverlay?: boolean;
    nativePaneChrome?: boolean;
    nativeWindowChrome?: boolean;
    publicSharing?: boolean;
  } = {},
): UiHost {
  const usesWindowsControls = options.titleBarOverlay !== false
    && options.nativeWindowChrome !== false
    && usesWindowsWindowControls(desktopPlatform);
  return {
    kind: "desktop-web",
    capabilities: {
      nativePaneChrome: options.nativePaneChrome ?? true,
      titleBarOverlay: options.titleBarOverlay ?? true,
      nativeWindowChrome: options.nativeWindowChrome ?? true,
      publicSharing: options.publicSharing ?? false,
      precisePointer: true,
      fractionalViewport: true,
      cellWidthPx: WEB_CELL_WIDTH,
      cellHeightPx: WEB_CELL_HEIGHT,
      pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
      canvasCharts: true,
      nativeContextMenu: options.nativeContextMenu ?? false,
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
              key={imageSrc}
              src={imageSrc}
              alt={alt}
              draggable={false}
              onError={() => setFailed(true)}
              style={{ width: "100%", height: "100%", display: "block", objectFit }}
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
