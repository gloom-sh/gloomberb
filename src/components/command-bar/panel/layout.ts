import type { LayoutBounds } from "../../../plugins/pane-manager";
import { resolveAppHeaderHeightCells } from "../../layout/shell/chrome";
import { estimateWorkflowBodyRows } from "../workflow/fields";
import type { CommandBarRoute } from "../workflow/types";

/**
 * Widest the results column gets. The sheet spans the window, but a label that
 * runs 180 cells is unreadable and the right column would drift off to where
 * the eye never goes. Left-aligned under the header prompt rather than centred
 * so the list stays attached to the prompt it drops out of.
 */
const RESULTS_MAX_WIDTH = 110;

export interface CommandBarPanelLayout {
  barWidth: number;
  baseBodyHeight: number;
  bodyHeight: number;
  contentPadding: number;
  listBodyHeight: number;
  nativeOccluderRect: LayoutBounds;
  nativePanelPaddingColumns: number;
  panelBounds: LayoutBounds;
  queryDisplayWidth: number;
  labelWidth: number;
  trailingWidth: number;
  resultsInnerWidth: number;
  shouldUseCompactListHeight: boolean;
}

export function resolveCommandBarPanelLayout({
  cellHeightPx,
  cellWidthPx,
  currentRoute,
  hasVisibleListState,
  nativeListRowCount,
  nativePaneChrome,
  showCustomMultiSelectPicker,
  termHeight,
  termWidth,
  themePickerActive,
  titleBarOverlay,
}: {
  cellHeightPx: number;
  cellWidthPx: number;
  currentRoute: CommandBarRoute | null;
  hasVisibleListState: boolean;
  nativeListRowCount: number;
  nativePaneChrome: boolean;
  showCustomMultiSelectPicker: boolean;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  titleBarOverlay: boolean | undefined;
}): CommandBarPanelLayout {
  const barWidth = termWidth;
  const baseBodyHeight = Math.min(16, Math.max(9, termHeight - 9));
  const contentPadding = nativePaneChrome ? 1 : 3;
  const workflowBodyHeight = currentRoute?.kind === "workflow"
    ? Math.min(
      Math.max(9, termHeight - (nativePaneChrome ? 7 : 9)),
      Math.max(7, estimateWorkflowBodyRows(currentRoute)),
    )
    : baseBodyHeight;
  const shouldUseCompactListHeight = nativePaneChrome
    && hasVisibleListState
    && !themePickerActive
    && !showCustomMultiSelectPicker;
  const listBodyHeight = shouldUseCompactListHeight
    ? Math.min(baseBodyHeight, Math.max(1, nativeListRowCount))
    : baseBodyHeight;
  const bodyHeight = currentRoute?.kind === "workflow"
    ? workflowBodyHeight
    : shouldUseCompactListHeight
      ? listBodyHeight
      : baseBodyHeight;
  const nativePanelPaddingColumns = nativePaneChrome
    ? Math.ceil((14 * 2) / Math.max(1, cellWidthPx))
    : 0;
  const nativePanelPaddingRows = nativePaneChrome
    ? Math.ceil((14 * 2) / Math.max(1, cellHeightPx))
    : 0;
  // The query lives in the header prompt, so the sheet's only chrome row is the
  // shortcut feedback line on the root screen or the back link on a nested one.
  // The terminal adds a title row and a padding row at the bottom edge.
  const bodyChromeRows = 1;
  const barHeight = nativePaneChrome
    ? bodyHeight + bodyChromeRows + nativePanelPaddingRows
    : bodyHeight + bodyChromeRows + 2;
  const appHeaderHeight = resolveAppHeaderHeightCells({ titleBarOverlay, cellHeightPx });
  const barTop = appHeaderHeight;
  const resultsInnerWidth = Math.max(
    12,
    Math.min(RESULTS_MAX_WIDTH, barWidth - nativePanelPaddingColumns - contentPadding * 2),
  );
  const trailingWidth = Math.max(8, Math.min(12, Math.floor(resultsInnerWidth * 0.18)));
  const labelWidth = Math.max(10, resultsInnerWidth - trailingWidth);
  const queryDisplayWidth = Math.max(8, resultsInnerWidth);

  return {
    barWidth,
    baseBodyHeight,
    bodyHeight,
    contentPadding,
    listBodyHeight,
    // Occluder coordinates are relative to the content area, which starts where
    // the sheet does, so the sheet's own top is the content origin.
    nativeOccluderRect: {
      x: 0,
      y: 0,
      width: barWidth,
      height: barHeight,
    },
    nativePanelPaddingColumns,
    panelBounds: {
      x: 0,
      y: barTop,
      width: barWidth,
      height: barHeight,
    },
    queryDisplayWidth,
    labelWidth,
    trailingWidth,
    resultsInnerWidth,
    shouldUseCompactListHeight,
  };
}
