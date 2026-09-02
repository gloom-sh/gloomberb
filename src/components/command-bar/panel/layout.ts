import type { LayoutBounds } from "../../../plugins/pane-manager";
import { resolveAppHeaderHeightCells, resolveHeaderPromptGeometry } from "../../layout/shell/chrome";
import { estimateWorkflowBodyRows } from "../workflow/fields";
import { NATIVE_COMMAND_SURFACE } from "./native-surface";
import type { CommandBarRoute } from "../workflow/types";

const BODY_MIN_ROWS = 9;
const BODY_MAX_ROWS = 26;
/** Rows a short window keeps regardless of its share, so 24-row terminals lose nothing. */
const BODY_SHORT_WINDOW_ROWS = 16;
/** Share of the window a tall one gives the list; multi-line document rows need the room. */
const BODY_HEIGHT_SHARE = 0.55;
/** Rows of the app that stay visible under the sheet on the terminal. */
const TERMINAL_BOTTOM_CLEARANCE = 6;
const DESKTOP_BOTTOM_CLEARANCE = 4;
/** One padding row above the list and one below. */
const SHEET_PADDING_ROWS = 2;
/** The chrome row plus the blank line that separates it from the first heading. */
const CHROME_ROWS = 2;

export interface CommandBarPanelLayout {
  barWidth: number;
  baseBodyHeight: number;
  bodyHeight: number;
  contentPadding: number;
  /** True when the sheet opens with a chrome row (back link, feedback) above the list. */
  hasChromeRow: boolean;
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
  hasRootFeedback,
  hasVisibleListState,
  nativeListRowCount,
  nativePaneChrome,
  nativeWindowChrome,
  showCustomMultiSelectPicker,
  termHeight,
  termWidth,
  themePickerActive,
  titleBarOverlay,
}: {
  cellHeightPx: number;
  cellWidthPx: number;
  currentRoute: CommandBarRoute | null;
  hasRootFeedback: boolean;
  hasVisibleListState: boolean;
  nativeListRowCount: number;
  nativePaneChrome: boolean;
  nativeWindowChrome?: boolean;
  showCustomMultiSelectPicker: boolean;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  titleBarOverlay: boolean | undefined;
}): CommandBarPanelLayout {
  const prompt = resolveHeaderPromptGeometry({ nativePaneChrome, nativeWindowChrome, termWidth, titleBarOverlay });
  const barWidth = prompt.width;
  const contentPadding = nativePaneChrome ? 1 : 3;
  const nativePanelPaddingColumns = nativePaneChrome
    ? Math.ceil((NATIVE_COMMAND_SURFACE.paddingXPx * 2) / Math.max(1, cellWidthPx))
    : 0;
  const nativePanelPaddingRows = nativePaneChrome
    ? Math.ceil((NATIVE_COMMAND_SURFACE.paddingYPx * 2) / Math.max(1, cellHeightPx))
    : 0;
  // A nested screen shows its back link; the root shows shortcut feedback when
  // there is any. Otherwise the list starts right under the padding row.
  const hasChromeRow = currentRoute !== null || hasRootFeedback;
  const paddingRows = nativePaneChrome ? nativePanelPaddingRows : SHEET_PADDING_ROWS;
  const chromeRows = hasChromeRow ? CHROME_ROWS : 0;
  const bottomClearance = nativePaneChrome ? DESKTOP_BOTTOM_CLEARANCE : TERMINAL_BOTTOM_CLEARANCE;
  // Budgeted for a sheet without a chrome row; the row and its blank line are
  // paid out of the list, so the sheet's footprint does not jump when a typed
  // prefix brings feedback or a nested screen brings its back link.
  const listBudget = Math.max(
    BODY_MIN_ROWS,
    Math.min(
      BODY_MAX_ROWS,
      termHeight - bottomClearance - paddingRows,
      Math.max(BODY_SHORT_WINDOW_ROWS, Math.floor(termHeight * BODY_HEIGHT_SHARE)),
    ),
  );
  const baseBodyHeight = Math.max(BODY_MIN_ROWS, listBudget - chromeRows);
  const workflowBodyHeight = currentRoute?.kind === "workflow"
    ? Math.min(
      Math.max(BODY_MIN_ROWS, termHeight - bottomClearance - paddingRows - chromeRows),
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
  const barHeight = bodyHeight + paddingRows + chromeRows;
  const appHeaderHeight = resolveAppHeaderHeightCells({ titleBarOverlay, cellHeightPx });
  const barTop = appHeaderHeight;
  const resultsInnerWidth = Math.max(12, barWidth - nativePanelPaddingColumns - contentPadding * 2);
  const trailingWidth = Math.max(8, Math.min(12, Math.floor(resultsInnerWidth * 0.18)));
  const labelWidth = Math.max(10, resultsInnerWidth - trailingWidth);
  const queryDisplayWidth = Math.max(8, resultsInnerWidth);

  return {
    barWidth,
    baseBodyHeight,
    bodyHeight,
    contentPadding,
    hasChromeRow,
    listBodyHeight,
    // Occluder coordinates are relative to the content area, which starts where
    // the sheet does, so the sheet's own top is the content origin.
    nativeOccluderRect: {
      x: prompt.left,
      y: 0,
      width: barWidth,
      height: barHeight,
    },
    nativePanelPaddingColumns,
    panelBounds: {
      x: prompt.left,
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
