import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";
import { higherContrast } from "../../../theme/color-utils";
import type { FloatingResizeCorner, FloatingRect, LayoutBounds, DockGeometryOptions } from "../../../plugins/pane-manager";
import {
  windowEditHasPendingCommit,
  type WindowEditState,
} from "./mode";
import {
  windowEditHelpText,
  windowEditStatusLine,
} from "./presentation";

const NATIVE_WINDOW_EDIT_PANEL_MAX_WIDTH = 78;
const NATIVE_WINDOW_EDIT_PANEL_HEIGHT = 3;
const NATIVE_WINDOW_EDIT_CORNER_SIZE = 2;

export function resolveNativeWindowEditPanelRect(width: number, contentHeight: number): LayoutBounds | null {
  const availableWidth = Math.max(0, Math.floor(width));
  const availableHeight = Math.max(0, Math.floor(contentHeight));
  if (availableWidth <= 0 || availableHeight <= 0) return null;

  const panelWidth = Math.max(1, Math.min(NATIVE_WINDOW_EDIT_PANEL_MAX_WIDTH, availableWidth - 2));
  const panelHeight = Math.min(NATIVE_WINDOW_EDIT_PANEL_HEIGHT, availableHeight);
  return {
    x: Math.max(0, Math.floor((availableWidth - panelWidth) / 2)),
    y: availableHeight <= panelHeight ? 0 : 1,
    width: panelWidth,
    height: panelHeight,
  };
}

export function resolveNativeFloatingResizeCornerRect(rect: FloatingRect, corner: FloatingResizeCorner): LayoutBounds {
  const size = Math.max(1, Math.min(NATIVE_WINDOW_EDIT_CORNER_SIZE, rect.width, rect.height));
  const x = corner === "left"
    ? rect.x
    : corner === "right"
      ? Math.max(rect.x, rect.x + rect.width - size)
      : corner === "top" || corner === "bottom"
        ? rect.x + Math.floor((rect.width - size) / 2)
        : corner === "top-left" || corner === "bottom-left"
          ? rect.x
          : Math.max(rect.x, rect.x + rect.width - size);
  const y = corner === "top"
    ? rect.y
    : corner === "bottom"
      ? Math.max(rect.y, rect.y + rect.height - size)
      : corner === "left" || corner === "right"
        ? rect.y + Math.floor((rect.height - size) / 2)
        : corner === "top-left" || corner === "top-right"
          ? rect.y
          : Math.max(rect.y, rect.y + rect.height - size);
  return { x, y, width: size, height: size };
}

function truncateStatusText(text: string, width: number): string {
  if (width <= 0) return "";
  if (text.length <= width) return text;
  if (width <= 3) return ".".repeat(width);
  return `${text.slice(0, width - 3)}...`;
}

export function NativeWindowEditStatus({
  mode,
  title,
  rect,
  bounds,
  dockGeometryOptions,
  targetTitle,
  zIndex,
}: {
  mode: WindowEditState;
  title: string;
  rect: LayoutBounds;
  bounds: LayoutBounds;
  dockGeometryOptions: DockGeometryOptions;
  targetTitle?: string;
  zIndex: number;
}) {
  const lineWidth = Math.max(1, rect.width - 2);
  const status = windowEditStatusLine(mode, title, bounds, dockGeometryOptions, targetTitle);
  const pending = windowEditHasPendingCommit(mode, bounds, dockGeometryOptions) ? " - pending" : "";
  const help = windowEditHelpText(mode);
  const textColor = higherContrast("#ffffff", "#000000", colors.borderFocused);

  return (
    <Box
      position="absolute"
      left={rect.x}
      top={rect.y}
      width={rect.width}
      height={rect.height}
      zIndex={zIndex}
      flexDirection="column"
      paddingX={1}
      data-gloom-role="window-mode-status"
    >
      <Text fg={textColor} bold selectable={false} width={lineWidth}>
        {truncateStatusText(`${status}${pending}`, lineWidth)}
      </Text>
      {rect.height > 1 && (
        <Text fg={textColor} selectable={false} width={lineWidth}>
          {truncateStatusText(help, lineWidth)}
        </Text>
      )}
      {rect.height > 2 && (
        <Text fg={textColor} selectable={false} width={lineWidth}>
          {truncateStatusText("Click a window to select it, drag dividers or handles to resize", lineWidth)}
        </Text>
      )}
    </Box>
  );
}
