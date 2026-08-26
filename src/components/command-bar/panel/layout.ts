import type { LayoutBounds } from "../../../plugins/pane-manager";
import { resolveAppHeaderHeightCells } from "../../layout/shell/chrome";
import { estimateWorkflowBodyRows } from "../workflow/fields";
import type { CommandBarRoute } from "../workflow/types";

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
  const barWidth = nativePaneChrome
    ? Math.max(46, Math.min(78, termWidth - 10, Math.floor(termWidth * 0.64)))
    : Math.max(42, Math.min(72, termWidth - 8, Math.floor(termWidth * 0.68)));
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
  const nativeBodyChromeRows = (currentRoute?.kind === "workflow"
    || currentRoute?.kind === "confirm"
    || showCustomMultiSelectPicker)
    ? 1
    : currentRoute ? 3 : 2;
  const barHeight = nativePaneChrome
    ? bodyHeight + nativeBodyChromeRows + nativePanelPaddingRows
    : bodyHeight + 7;
  const barLeft = Math.max(4, Math.floor((termWidth - barWidth) / 2));
  const barTop = Math.max(1, Math.floor((termHeight - barHeight) / 2));
  const appHeaderHeight = resolveAppHeaderHeightCells({ titleBarOverlay, cellHeightPx });
  const resultsInnerWidth = Math.max(12, barWidth - nativePanelPaddingColumns - contentPadding * 2);
  const trailingWidth = Math.max(8, Math.min(12, Math.floor(resultsInnerWidth * 0.18)));
  const labelWidth = Math.max(10, resultsInnerWidth - trailingWidth);
  const queryDisplayWidth = Math.max(8, resultsInnerWidth);

  return {
    barWidth,
    baseBodyHeight,
    bodyHeight,
    contentPadding,
    listBodyHeight,
    nativeOccluderRect: {
      x: barLeft,
      y: barTop - appHeaderHeight,
      width: barWidth,
      height: barHeight,
    },
    nativePanelPaddingColumns,
    panelBounds: {
      x: barLeft,
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
