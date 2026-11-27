import { useState, type ReactNode } from "react";
import {
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  PaneSidebar,
  readStoredPaneSidebarWidth,
  shouldShowPaneSidebar,
} from "../../../components";
import { Box, useUiCapabilities } from "../../../ui";
import { usePluginPaneState } from "../../runtime";

export function useMapSplitLayout({
  width,
  height,
  rowCount,
  defaultSidebarWidth,
  stackedMapHeight,
}: {
  width: number;
  height: number;
  rowCount: number;
  defaultSidebarWidth: number;
  stackedMapHeight: number;
}) {
  const { nativePaneChrome } = useUiCapabilities();
  const native = !!nativePaneChrome;
  const [storedSidebarWidth, setStoredSidebarWidth] = usePluginPaneState<number | null>("sidebarWidth", null);
  const [draggedSidebarWidth, setDraggedSidebarWidth] = useState<number | null>(null);
  const horizontal = shouldShowPaneSidebar(rowCount, width, height);
  // The terminal draws the divider as a cell inside the sidebar; the desktop as a hairline.
  const sidebarWidth = horizontal
    ? getPaneSidebarWidth(
      width,
      native,
      draggedSidebarWidth ?? readStoredPaneSidebarWidth(storedSidebarWidth) ?? (defaultSidebarWidth + (native ? 0 : 1)),
    )
    : width;
  const sidebarRange = getPaneSidebarWidthRange(width);
  const listWidth = horizontal && !native ? Math.max(1, sidebarWidth - 1) : sidebarWidth;
  const mapWidth = horizontal ? Math.max(1, width - sidebarWidth) : width;
  const mapSectionHeight = horizontal ? height : stackedMapHeight;
  const tableHeight = horizontal ? height : Math.max(4, height - mapSectionHeight);

  const renderSplit = (focused: boolean, table: ReactNode, map: ReactNode) => (
    horizontal ? (
      <Box flexDirection="row" width={width} height={height}>
        <PaneSidebar
          width={sidebarWidth}
          height={height}
          focused={focused}
          resize={{
            min: sidebarRange.min,
            max: sidebarRange.max,
            onResize: setDraggedSidebarWidth,
            onResizeEnd: (next) => {
              setStoredSidebarWidth(next);
              setDraggedSidebarWidth(null);
            },
          }}
        >
          {table}
        </PaneSidebar>
        {map}
      </Box>
    ) : (
      <Box flexDirection="column" width={width} height={height}>
        {map}
        {table}
      </Box>
    )
  );

  return { nativePaneChrome, horizontal, listWidth, mapWidth, mapSectionHeight, tableHeight, renderSplit };
}
