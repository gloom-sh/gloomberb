import { useLayoutEffect } from "react";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../../ui";
import { truncateToDisplayWidth } from "../../../utils/format";
import { Button } from "../../ui";
import type { ListScreenState } from "../list/model";
import { CommandBarListBody } from "../list/view";
import { ThemePicker } from "../theme-picker";
import type { CommandBarRoute } from "../workflow/types";
import { NATIVE_COMMAND_SURFACE, nativeCommandSurfaceBorder } from "./native-surface";
import { useCommandBarPalette } from "./palette";
import { publishCommandBarPrompt } from "./prompt-binding";
import type { CommandBarPanelProps } from "./types";

const COMMAND_BAR_OVERLAY_Z_INDEX = 2_147_483_646;
const COMMAND_BAR_PANEL_Z_INDEX = 2_147_483_647;

/**
 * The root screen keeps the closed prompt's own words. Opening the bar puts the
 * caret in the same input the header was already showing, so changing the
 * placeholder underneath it read as the control being swapped out. Nested
 * screens are a different screen and say so.
 */
function resolvePromptPlaceholder(listState: ListScreenState): string {
  if (listState.kind === "root") return t("Search or run a command");
  if (listState.title === "Security Description") return t("Search tickers");
  return t("Filter");
}

export function CommandBarPanel({
  bodySlotKey,
  committedThemeId,
  contentPadding,
  currentRoute,
  hasChromeRow,
  labelWidth,
  listBodyHeight,
  nativeListRows,
  nativeListScrollRef,
  nativeOccluderRect,
  nativePaneChrome,
  onBack,
  onListHoverIndex,
  onListRowMouseDown,
  onListScroll,
  onNativeOccluderChange,
  onOverlayClose,
  onQueryChange,
  onThemeCommit,
  onThemePreview,
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
}: CommandBarPanelProps) {
  const colors = useThemeColors();
  const palette = useCommandBarPalette(nativePaneChrome);

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

  // The header prompt is the bar's input while a list screen is showing.
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
        backgroundColor={palette.panelBg}
        zIndex={nativePaneChrome ? COMMAND_BAR_PANEL_Z_INDEX : 101}
        onMouseDown={(event: any) => {
          event.stopPropagation?.();
        }}
        data-gloom-role="command-bar-panel"
        style={nativePaneChrome ? {
          // The lower half of the control the header input opens: rounded and
          // bordered along its three free edges, open where the input sits.
          border: `1px solid ${nativeCommandSurfaceBorder(colors)}`,
          borderTopWidth: 0,
          borderRadius: `0 0 ${NATIVE_COMMAND_SURFACE.radiusPx}px ${NATIVE_COMMAND_SURFACE.radiusPx}px`,
          boxShadow: NATIVE_COMMAND_SURFACE.shadow,
          overflow: "hidden",
          padding: `${NATIVE_COMMAND_SURFACE.paddingYPx}px ${NATIVE_COMMAND_SURFACE.paddingXPx}px`,
        } : undefined}
      >
        {/* The desktop sheet pads itself in CSS; the terminal spends a row. */}
        {!nativePaneChrome && <Box height={1} />}

        {/* Rows stop at the results column, so a selection bar on a wide window
          does not run on past the text into empty sheet. */}
        <Box
          key={bodySlotKey}
          flexDirection="column"
          flexGrow={1}
          width={queryDisplayWidth + contentPadding * 2}
          backgroundColor={palette.panelBg}
        >
          {/* The query itself is typed in the header prompt. This row only exists
            when it has something to say: the way back from a nested screen, or
            what a typed prefix resolved to. Its height is reserved in
            panel/layout.ts, which is why the render is keyed on the same flag. */}
          {hasChromeRow && (
            <>
              <Box height={1} paddingX={contentPadding} flexDirection="row">
                {currentRoute ? (
                  <>
                    <Button
                      label={t("Back")}
                      displayLabel={nativePaneChrome ? `‹ ${t("Back")}` : `\u2190 ${t("Back")}`}
                      variant="plain"
                      compact
                      flush
                      stopPropagation
                      onPress={onBack}
                    />
                    <Box width={2} />
                    <Text fg={palette.text} attributes={TextAttributes.BOLD}>
                      {truncateToDisplayWidth(t(getCommandBarPanelTitle(currentRoute)), Math.max(1, queryDisplayWidth - 8))}
                    </Text>
                  </>
                ) : rootShortcutFeedback ? (
                  <Text fg={palette.subtle}>
                    {truncateToDisplayWidth(rootShortcutFeedback, queryDisplayWidth)}
                  </Text>
                ) : null}
              </Box>
              <Box height={1} />
            </>
          )}

          {themePickerActive && (
            <ThemePicker
              ref={themePickerRef}
              filter={themePickerFilter}
              committedThemeId={committedThemeId}
              height={listBodyHeight}
              contentPadding={contentPadding}
              labelWidth={labelWidth}
              trailingWidth={trailingWidth}
              queryDisplayWidth={queryDisplayWidth}
              nativePaneChrome={nativePaneChrome}
              onPreview={onThemePreview}
              onCommit={onThemeCommit}
            />
          )}

          {visibleListState && !themePickerActive && (
            <CommandBarListBody
              visibleListState={visibleListState}
              nativeListRows={nativeListRows}
              listBodyHeight={listBodyHeight}
              contentPadding={contentPadding}
              labelWidth={labelWidth}
              nativePaneChrome={nativePaneChrome}
              nativeListScrollRef={nativeListScrollRef}
              queryDisplayWidth={queryDisplayWidth}
              trailingWidth={trailingWidth}
              onHoverIndex={onListHoverIndex}
              onListScroll={onListScroll}
              onRowMouseDown={onListRowMouseDown}
            />
          )}
        </Box>

        {!nativePaneChrome && <Box height={1} />}
      </Box>
    </Box>
  );
}

function getCommandBarPanelTitle(route: CommandBarRoute): string {
  if (route.kind === "mode") {
    if (route.screen === "layout") return "Layout Actions";
    return "Security Description";
  }
  return route.title;
}
