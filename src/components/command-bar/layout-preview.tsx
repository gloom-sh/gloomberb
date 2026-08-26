import { useMemo } from "react";
import { Box } from "../../ui";
import { useViewport } from "../../react/input";
import { useThemeColors } from "../../theme/theme-context";
import { getDockLeafLayouts, type LayoutBounds } from "../../plugins/pane-manager";
import type { LayoutConfig } from "../../types/config";

/** Rows the schematic occupies; enough for a three-deep split to stay readable. */
export const LAYOUT_PREVIEW_ROWS = 7;
/** Below this the list is too cramped to give rows away for a picture. */
const MIN_LIST_ROWS_WITH_PREVIEW = 5;
/** A bordered box needs two cells before it reads as a box at all. */
const MIN_RECT_SIZE = 2;

type LayoutPreviewKind = "docked" | "floating" | "detached";

export interface LayoutPreviewRect {
  key: string;
  kind: LayoutPreviewKind;
  rect: LayoutBounds;
}

export function resolveLayoutPreviewRows({
  hasSelectedLayoutPreview,
  chromeRows,
  growPanel,
  listBodyHeight,
  termHeight,
}: {
  hasSelectedLayoutPreview: boolean;
  /** Rows the panel spends on chrome around the body, native chrome only. */
  chromeRows: number;
  /** Native chrome sizes the panel to its rows, so the panel grows instead of the list shrinking. */
  growPanel: boolean;
  listBodyHeight: number;
  termHeight: number;
}): number {
  if (!hasSelectedLayoutPreview) return 0;
  const fits = growPanel
    ? listBodyHeight + LAYOUT_PREVIEW_ROWS + chromeRows <= termHeight
    : listBodyHeight - LAYOUT_PREVIEW_ROWS >= MIN_LIST_ROWS_WITH_PREVIEW;
  return fits ? LAYOUT_PREVIEW_ROWS : 0;
}

function snapRect(rect: LayoutBounds, bounds: { width: number; height: number }): LayoutBounds {
  const maxX = Math.max(0, bounds.width - MIN_RECT_SIZE);
  const maxY = Math.max(0, bounds.height - MIN_RECT_SIZE);
  const x = Math.max(0, Math.min(maxX, Math.round(rect.x)));
  const y = Math.max(0, Math.min(maxY, Math.round(rect.y)));
  return {
    x,
    y,
    width: Math.max(MIN_RECT_SIZE, Math.min(bounds.width - x, Math.round(rect.x + rect.width) - x)),
    height: Math.max(MIN_RECT_SIZE, Math.min(bounds.height - y, Math.round(rect.y + rect.height) - y)),
  };
}

/**
 * Docked panes come from the real dock geometry at preview scale; floating and
 * detached panes are stored in screen cells, so they are scaled by the screen
 * the layout is being previewed against.
 */
export function buildLayoutPreviewRects(
  layout: LayoutConfig,
  bounds: { width: number; height: number },
  screen: { width: number; height: number },
): LayoutPreviewRect[] {
  const scaleX = bounds.width / Math.max(1, screen.width);
  const scaleY = bounds.height / Math.max(1, screen.height);
  const scaled = (
    entries: readonly { instanceId: string; x: number; y: number; width: number; height: number }[],
    kind: LayoutPreviewKind,
  ): LayoutPreviewRect[] => entries.map((entry) => ({
    key: `${kind}:${entry.instanceId}`,
    kind,
    rect: snapRect({
      x: entry.x * scaleX,
      y: entry.y * scaleY,
      width: entry.width * scaleX,
      height: entry.height * scaleY,
    }, bounds),
  }));

  return [
    ...getDockLeafLayouts(layout, { x: 0, y: 0, ...bounds }, { precise: true }).map((leaf) => ({
      key: `docked:${leaf.instanceId}`,
      kind: "docked" as const,
      rect: snapRect(leaf.rect, bounds),
    })),
    ...scaled(layout.floating, "floating"),
    ...scaled(layout.detached ?? [], "detached"),
  ];
}

/** Noninteractive schematic of a layout: real bordered boxes, no cell art. */
export function CommandBarLayoutPreview({
  contentPadding,
  height,
  layout,
  width,
}: {
  contentPadding: number;
  height: number;
  layout: LayoutConfig;
  width: number;
}) {
  const themeColors = useThemeColors();
  const { width: screenWidth, height: screenHeight } = useViewport();
  const rects = useMemo(
    () => buildLayoutPreviewRects(layout, { width, height }, { width: screenWidth, height: screenHeight }),
    [height, layout, screenHeight, screenWidth, width],
  );
  const tone: Record<LayoutPreviewKind, { border: string; background: string; zIndex: number }> = {
    docked: { border: themeColors.border, background: themeColors.panel, zIndex: 1 },
    floating: { border: themeColors.borderFocused, background: themeColors.header, zIndex: 2 },
    detached: { border: themeColors.warning, background: themeColors.bg, zIndex: 3 },
  };

  return (
    <Box height={height} paddingX={contentPadding}>
      <Box
        position="relative"
        width={width}
        height={height}
        data-gloom-role="command-bar-layout-preview"
      >
        {rects.map((entry) => (
          <Box
            key={entry.key}
            position="absolute"
            left={entry.rect.x}
            top={entry.rect.y}
            width={entry.rect.width}
            height={entry.rect.height}
            border
            borderStyle="single"
            borderColor={tone[entry.kind].border}
            backgroundColor={tone[entry.kind].background}
            zIndex={tone[entry.kind].zIndex}
          />
        ))}
      </Box>
    </Box>
  );
}
