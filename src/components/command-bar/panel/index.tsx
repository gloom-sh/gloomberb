import { useLayoutEffect } from "react";
import { t } from "../../../i18n";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../../ui";
import { Button, Spinner } from "../../ui";
import type { ListScreenState } from "../list/model";
import { CommandBarListBody } from "../list/view";
import { CommandBarMultiSelectBody, isMultiSelectPickerRoute } from "../multi-select-picker";
import { ThemePicker } from "../theme-picker";
import { truncateText } from "../view-model";
import { CommandBarWorkflowBody } from "../workflow/body";
import type { CommandBarConfirmRoute, CommandBarRoute } from "../workflow/types";
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
  themePickerMode,
  themePickerFilter,
  themePickerRef,
  committedStyleId,
  trailingWidth,
  visibleListState,
  workflowScrollRef,
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
                    <Text
                      fg={palette.subtle}
                      onMouseDown={(event: any) => {
                        event.stopPropagation?.();
                        event.preventDefault?.();
                        onBack();
                      }}
                      data-gloom-interactive="true"
                    >
                      {`\u2190 ${t("Back")}`}
                    </Text>
                    <Box width={2} />
                    <Text fg={palette.text} attributes={TextAttributes.BOLD}>
                      {truncateText(t(getCommandBarPanelTitle(currentRoute)), Math.max(1, queryDisplayWidth - 8))}
                    </Text>
                  </>
                ) : rootShortcutFeedback ? (
                  <Text fg={palette.subtle}>
                    {truncateText(rootShortcutFeedback, queryDisplayWidth)}
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
              mode={themePickerMode}
              committedThemeId={committedThemeId}
              committedStyleId={committedStyleId}
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

          {visibleListState && !themePickerActive && !isMultiSelectPickerRoute(currentRoute) && (
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
          {currentRoute?.kind === "workflow" && (
            <CommandBarWorkflowBody
              route={currentRoute}
              bodyHeight={bodyHeight}
              contentPadding={contentPadding}
              nativePaneChrome={nativePaneChrome}
              queryDisplayWidth={queryDisplayWidth}
              workflowScrollRef={workflowScrollRef}
              getWorkflowInputRef={getWorkflowInputRef}
              onActiveTextareaSync={onWorkflowActiveTextareaSync}
              onFieldFocus={onFieldFocus}
              onFieldPickerOpen={onFieldPickerOpen}
              onFieldValueChange={onFieldValueChange}
              onMoveFieldFocus={onMoveFieldFocus}
              onNativeSelectRef={onNativeSelectRef}
              onSubmit={onWorkflowSubmit}
            />
          )}
          {currentRoute?.kind === "confirm" && (
            <CommandBarConfirmBody
              route={currentRoute}
              bodyHeight={bodyHeight}
              contentPadding={contentPadding}
              queryDisplayWidth={queryDisplayWidth}
              onConfirm={onConfirmRoute}
            />
          )}
          {isMultiSelectPickerRoute(currentRoute) && (
            <CommandBarMultiSelectBody
              route={currentRoute}
              bodyHeight={bodyHeight}
              contentPadding={contentPadding}
              nativePaneChrome={nativePaneChrome}
              onCommit={onMultiSelectCommit}
              onSelect={onMultiSelectSelect}
              onToggle={onMultiSelectToggle}
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
  if (route.kind === "picker") return route.title;
  if (route.kind === "pane-settings") return "Pane Settings";
  if (route.kind === "workflow") return route.title;
  return route.title;
}

function CommandBarConfirmBody({
  route,
  bodyHeight,
  contentPadding,
  queryDisplayWidth,
  onConfirm,
}: {
  route: CommandBarConfirmRoute;
  bodyHeight: number;
  contentPadding: number;
  queryDisplayWidth: number;
  onConfirm: () => void;
}) {
  const themeColors = useThemeColors();
  const palette = useCommandBarPalette(false);
  return (
    <Box flexDirection="column" height={bodyHeight} paddingX={contentPadding}>
      {route.body.map((line, index) => (
        <Box key={`confirm:${index}`} height={1}>
          <Text fg={palette.text}>{truncateText(t(line), queryDisplayWidth)}</Text>
        </Box>
      ))}
      <Box height={1} />
      {route.error && (
        <Box height={1}>
          <Text fg={themeColors.negative}>{truncateText(route.error, queryDisplayWidth)}</Text>
        </Box>
      )}
      {route.pending && (
        <Box height={1}>
          <Spinner label={t("Working…")} />
        </Box>
      )}
      <Box flexGrow={1} />
      <Box flexDirection="row" gap={1}>
        <Button
          label={t(route.confirmLabel)}
          variant={route.tone === "danger" ? "danger" : "primary"}
          onPress={onConfirm}
          disabled={route.pending}
        />
      </Box>
    </Box>
  );
}
