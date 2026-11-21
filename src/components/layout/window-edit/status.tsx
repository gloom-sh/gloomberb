import { navigationDirectionLabel, useKeybindings } from "../../../app/keybindings";
import { getShortcutDisplayMode } from "../../../utils/shortcut-labels";
import { Box, Text, useUiHost } from "../../../ui";
import { colors } from "../../../theme/colors";
import { higherContrast } from "../../../theme/color-utils";
import { NATIVE_CLIP_STYLE } from "../../ui/clip-style";
import type { FloatingResizeCorner, FloatingRect, LayoutBounds, DockGeometryOptions } from "../../../layout/pane-manager";
import {
  windowEditHasPendingCommit,
  type WindowEditState,
} from "./mode";
import {
  windowEditHelpItems,
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
  const x = corner === "top-left" || corner === "bottom-left"
    ? rect.x
    : Math.max(rect.x, rect.x + rect.width - size);
  const y = corner === "top-left" || corner === "top-right"
    ? rect.y
    : Math.max(rect.y, rect.y + rect.height - size);
  return { x, y, width: size, height: size };
}

const HELP_SEPARATOR = "  ";
const POINTER_HELP = "click a window to select it, drag to resize";

/**
 * Lays the key help over the panel's help lines in order, a whole item at a
 * time. The pointer hint takes what room is left on the last line; keys that
 * still do not fit stay on the last line, which CSS cuts where the panel
 * ends: its end holds the least used ones.
 */
export function wrapWindowEditHelp(items: readonly string[], width: number, lineCount: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const item of items) {
    const next = current ? `${current}${HELP_SEPARATOR}${item}` : item;
    if (next.length <= width || !current || lines.length === lineCount - 1) {
      current = next;
      continue;
    }
    lines.push(current);
    current = item;
  }
  if (current) lines.push(current);
  const last = lines.length - 1;
  if (last >= 0 && lines.length < lineCount) {
    lines.push(POINTER_HELP);
  } else if (last >= 0 && `${lines[last]}${HELP_SEPARATOR}${POINTER_HELP}`.length <= width) {
    lines[last] = `${lines[last]}${HELP_SEPARATOR}${POINTER_HELP}`;
  }
  return lines.slice(0, lineCount);
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
  const directions = navigationDirectionLabel(useKeybindings(), getShortcutDisplayMode(useUiHost().kind));
  const lineWidth = Math.max(1, rect.width - 2);
  const status = windowEditStatusLine(mode, title, bounds, dockGeometryOptions, targetTitle);
  const hasPending = windowEditHasPendingCommit(mode, bounds, dockGeometryOptions);
  const pending = hasPending ? " - pending" : "";
  const help = wrapWindowEditHelp(windowEditHelpItems(mode, hasPending, directions), lineWidth, Math.max(0, rect.height - 1));
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
      {/* The desktop's panel: each line ends in an ellipsis where the panel does. */}
      <Text fg={textColor} bold selectable={false} width={lineWidth} style={NATIVE_CLIP_STYLE}>
        {`${status}${pending}`}
      </Text>
      {help.map((line, index) => (
        <Text key={index} fg={textColor} selectable={false} width={lineWidth} style={NATIVE_CLIP_STYLE}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
