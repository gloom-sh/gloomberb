import { useLayoutEffect } from "react";
import { Box } from "../../../ui";
import {
  commandBarAccentText,
  commandBarBg,
  commandBarHeadingText,
  commandBarHoverBg,
  commandBarInputBg,
  commandBarPanelBg,
  commandBarSelectedBg,
  commandBarSelectedText,
  commandBarSubtleText,
  commandBarText,
} from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { t } from "../../../i18n";
import type { ListScreenState } from "../list/model";
import { CommandBarPanelBody } from "./body";
import { publishCommandBarPrompt } from "./prompt-binding";
import type { CommandBarPanelProps } from "./types";

const COMMAND_BAR_OVERLAY_Z_INDEX = 2_147_483_646;
const COMMAND_BAR_PANEL_Z_INDEX = 2_147_483_647;
const NATIVE_COMMAND_BAR_PADDING_X_PX = 14;
const NATIVE_COMMAND_BAR_PADDING_Y_PX = 14;
const NATIVE_COMMAND_BAR_SHADOW = "0 10px 18px color-mix(in srgb, var(--gloom-bg) 34%, transparent)";

function resolvePromptPlaceholder(listState: ListScreenState): string {
  if (listState.kind === "root") return t("Command or plain English…");
  if (listState.title === "Security Description") return t("Search tickers");
  return t("Filter");
}

export function CommandBarPanel({
  bodyHeight,
  bodySlotKey,
  committedThemeId,
  contentPadding,
  currentRoute,
  getWorkflowInputRef,
  hasChromeRow,
  labelWidth,
  listBodyHeight,
  nativeListRows,
  nativeListScrollRef,
  nativeOccluderRect,
  nativePaneChrome,
  onBack,
  onConfirmRoute,
  onFieldFocus,
  onFieldPickerOpen,
  onFieldValueChange,
  onListHoverIndex,
  onListRowMouseDown,
  onListScroll,
  onMoveFieldFocus,
  onMultiSelectCommit,
  onMultiSelectSelect,
  onMultiSelectToggle,
  onNativeOccluderChange,
  onNativeSelectRef,
  onOverlayClose,
  onQueryChange,
  onThemeCommit,
  onThemePreview,
  onWorkflowActiveTextareaSync,
  onWorkflowSubmit,
  panelBounds,
  queryDisplayWidth,
  rootGhostSuffix,
  rootShortcutFeedback,
  selectedScrollRowIndex,
  termHeight,
  termWidth,
  themePickerActive,
  themePickerFilter,
  themePickerRef,
  trailingWidth,
  visibleListState,
  workflowScrollRef,
}: CommandBarPanelProps) {
  const colors = useThemeColors();
  const paletteAccentText = commandBarAccentText(colors);
  const paletteBg = commandBarBg(colors);
  const paletteHeadingText = commandBarHeadingText(colors);
  const paletteHoverBg = commandBarHoverBg(colors);
  const paletteSelectedBg = commandBarSelectedBg(colors);
  const paletteSelectedText = commandBarSelectedText(colors);
  const paletteText = commandBarText(colors);
  const paletteSubtleText = commandBarSubtleText(colors);
  const panelBg = nativePaneChrome ? commandBarPanelBg(colors) : paletteBg;
  const inputBg = nativePaneChrome ? commandBarInputBg(colors) : paletteBg;

  useLayoutEffect(() => {
    const scrollBox = nativeListScrollRef.current;
    if (!scrollBox) return;
    if (scrollBox.verticalScrollBar) scrollBox.verticalScrollBar.visible = false;
    if (selectedScrollRowIndex < 0) return;
    const viewportHeight = Math.max(1, scrollBox.viewport?.height ?? listBodyHeight);
    if (selectedScrollRowIndex < scrollBox.scrollTop) {
      scrollBox.scrollTo(selectedScrollRowIndex);
    } else if (selectedScrollRowIndex >= scrollBox.scrollTop + viewportHeight) {
      scrollBox.scrollTo(selectedScrollRowIndex - viewportHeight + 1);
    }
  }, [listBodyHeight, nativeListScrollRef, selectedScrollRowIndex, visibleListState?.kind, visibleListState?.query]);

  // The header prompt is the bar's input while a list screen is showing. A
  // workflow owns its own fields, so it publishes nothing and the prompt goes
  // quiet rather than taking focus from them.
  useLayoutEffect(() => {
    if (!visibleListState) {
      publishCommandBarPrompt(null);
      return;
    }
    publishCommandBarPrompt({
      screenKey: `${visibleListState.kind}:${visibleListState.title}`,
      query: visibleListState.query,
      placeholder: resolvePromptPlaceholder(visibleListState),
      ghostSuffix: visibleListState.kind === "root" ? rootGhostSuffix : null,
      onQueryChange,
    });
  }, [onQueryChange, rootGhostSuffix, visibleListState]);
  useLayoutEffect(() => () => publishCommandBarPrompt(null), []);

  useLayoutEffect(() => {
    onNativeOccluderChange?.(nativeOccluderRect);
    return () => {
      onNativeOccluderChange?.(null);
    };
  }, [
    nativeOccluderRect.height,
    nativeOccluderRect.width,
    nativeOccluderRect.x,
    nativeOccluderRect.y,
    onNativeOccluderChange,
  ]);

  return (
    // The click-away overlay starts where the sheet does: the header above it
    // holds the bar's input, and a click there must reach it, not close the bar.
    <Box
      position="absolute"
      top={panelBounds.y}
      left={0}
      width={termWidth}
      height={Math.max(0, termHeight - panelBounds.y)}
      zIndex={nativePaneChrome ? COMMAND_BAR_OVERLAY_Z_INDEX : 100}
      onMouseDown={(event: any) => {
        event.stopPropagation?.();
        event.preventDefault?.();
        onOverlayClose();
      }}
    >
      <Box
        position="absolute"
        top={0}
        left={panelBounds.x}
        width={panelBounds.width}
        height={panelBounds.height}
        flexDirection="column"
        backgroundColor={panelBg}
        zIndex={nativePaneChrome ? COMMAND_BAR_PANEL_Z_INDEX : 101}
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
        }}
        data-gloom-role="command-bar-panel"
        style={nativePaneChrome ? {
          // A sheet hanging off the header: square where it meets the header,
          // rounded only along its free bottom edge.
          borderRadius: "0 0 8px 8px",
          boxShadow: NATIVE_COMMAND_BAR_SHADOW,
          overflow: "hidden",
          padding: `${NATIVE_COMMAND_BAR_PADDING_Y_PX}px ${NATIVE_COMMAND_BAR_PADDING_X_PX}px`,
        } : undefined}
      >
        <CommandBarPanelBody
          bodyHeight={bodyHeight}
          bodySlotKey={bodySlotKey}
          committedThemeId={committedThemeId}
          contentPadding={contentPadding}
          currentRoute={currentRoute}
          getWorkflowInputRef={getWorkflowInputRef}
          hasChromeRow={hasChromeRow}
          labelWidth={labelWidth}
          listBodyHeight={listBodyHeight}
          nativeListRows={nativeListRows}
          nativeListScrollRef={nativeListScrollRef}
          nativePaneChrome={nativePaneChrome}
          onBack={onBack}
          onConfirmRoute={onConfirmRoute}
          onFieldFocus={onFieldFocus}
          onFieldPickerOpen={onFieldPickerOpen}
          onFieldValueChange={onFieldValueChange}
          onListHoverIndex={onListHoverIndex}
          onListRowMouseDown={onListRowMouseDown}
          onListScroll={onListScroll}
          onMoveFieldFocus={onMoveFieldFocus}
          onMultiSelectCommit={onMultiSelectCommit}
          onMultiSelectSelect={onMultiSelectSelect}
          onMultiSelectToggle={onMultiSelectToggle}
          onNativeSelectRef={onNativeSelectRef}
          onThemeCommit={onThemeCommit}
          onThemePreview={onThemePreview}
          onWorkflowActiveTextareaSync={onWorkflowActiveTextareaSync}
          onWorkflowSubmit={onWorkflowSubmit}
          palette={{
            inputBg,
            paletteAccentText,
            paletteBg,
            paletteHeadingText,
            paletteHoverBg,
            paletteSelectedBg,
            paletteSelectedText,
            paletteSubtleText,
            paletteText,
            panelBg,
          }}
          queryDisplayWidth={queryDisplayWidth}
          rootShortcutFeedback={rootShortcutFeedback}
          themePickerActive={themePickerActive}
          themePickerFilter={themePickerFilter}
          themePickerRef={themePickerRef}
          trailingWidth={trailingWidth}
          visibleListState={visibleListState}
          workflowScrollRef={workflowScrollRef}
        />
      </Box>
    </Box>
  );
}
