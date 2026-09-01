import { Box, Text, TextAttributes } from "../../../ui";
import { commandBarMatchText } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Button, Spinner } from "../../ui";
import {
  CommandBarListBody,
  CommandBarListHeader,
} from "../list/view";
import {
  CommandBarMultiSelectBody,
  isMultiSelectPickerRoute,
} from "../multi-select-picker";
import { ThemePicker } from "../theme-picker";
import type {
  CommandBarPanelPalette,
  CommandBarPanelProps,
} from "./types";
import { CommandBarWorkflowBody } from "../workflow/body";
import type { CommandBarConfirmRoute, CommandBarRoute } from "../workflow/types";
import { truncateText } from "../view-model";
import { t } from "../../../i18n";

type CommandBarPanelBodyProps = Omit<
  CommandBarPanelProps,
  | "nativeOccluderRect"
  | "onNativeOccluderChange"
  | "onOverlayClose"
  | "panelBounds"
  | "selectedScrollRowIndex"
  | "termHeight"
  | "termWidth"
> & {
  palette: CommandBarPanelPalette;
};

export function CommandBarPanelBody({
  bodyHeight,
  bodySlotKey,
  committedThemeId,
  contentPadding,
  currentRoute,
  getWorkflowInputRef,
  labelWidth,
  listBodyHeight,
  nativeListRows,
  nativeListScrollRef,
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
  onNativeSelectRef,
  onQueryChange,
  onThemeCommit,
  onThemePreview,
  onWorkflowActiveTextareaSync,
  onWorkflowSubmit,
  palette,
  queryDisplayWidth,
  rootGhostSuffix,
  rootQueryLength,
  rootShortcutFeedback,
  themePickerActive,
  themePickerFilter,
  themePickerRef,
  trailingWidth,
  visibleListState,
  workflowScrollRef,
}: CommandBarPanelBodyProps) {
  const themeColors = useThemeColors();
  const {
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
  } = palette;

  return (
    <>
      {!nativePaneChrome && <Box height={1} backgroundColor={paletteBg} />}

      {!nativePaneChrome && (
        <Box
          height={1}
          paddingX={contentPadding}
          flexDirection="row"
          alignItems="center"
        >
          {currentRoute && (
            <Box marginRight={1}>
              <Button label={t("Back")} variant="ghost" onPress={onBack} />
            </Box>
          )}
          <Box flexGrow={1}>
            <Text fg={paletteText} attributes={TextAttributes.BOLD}>
              {t(getCommandBarPanelTitle(currentRoute))}
            </Text>
          </Box>
        </Box>
      )}

      <Box key={bodySlotKey} flexDirection="column" flexGrow={1} width="100%" backgroundColor={panelBg}>
        {nativePaneChrome && currentRoute && (
          <Box height={1} paddingX={contentPadding}>
            <Text
              fg={paletteSubtleText}
              onMouseDown={(event: any) => {
                event.stopPropagation?.();
                event.preventDefault?.();
                onBack();
              }}
              data-gloom-interactive="true"
            >
              {`← ${t("Back")}`}
            </Text>
          </Box>
        )}
        {(visibleListState || currentRoute?.kind === "picker") && visibleListState && (
          <CommandBarListHeader
            kind={visibleListState.kind}
            title={visibleListState.title}
            query={visibleListState.query}
            queryDisplayWidth={queryDisplayWidth}
            nativePaneChrome={nativePaneChrome}
            inputBg={inputBg}
            paletteBg={paletteBg}
            paletteText={paletteText}
            paletteSubtleText={paletteSubtleText}
            cursorColor={themeColors.textBright}
            contentPadding={contentPadding}
            rootGhostSuffix={rootGhostSuffix}
            rootQueryLength={rootQueryLength}
            rootShortcutFeedback={rootShortcutFeedback}
            onQueryChange={onQueryChange}
          />
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
            paletteBg={paletteBg}
            paletteHoverBg={paletteHoverBg}
            paletteSelectedBg={paletteSelectedBg}
            paletteSelectedText={paletteSelectedText}
            paletteSubtleText={paletteSubtleText}
            paletteText={paletteText}
            panelBg={panelBg}
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
            paletteAccentText={paletteAccentText}
            paletteBg={paletteBg}
            paletteHeadingText={paletteHeadingText}
            paletteHoverBg={paletteHoverBg}
            paletteMatchText={commandBarMatchText(themeColors)}
            paletteSelectedBg={paletteSelectedBg}
            paletteSelectedText={paletteSelectedText}
            paletteSubtleText={paletteSubtleText}
            paletteText={paletteText}
            panelBg={panelBg}
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
            inputBg={inputBg}
            nativePaneChrome={nativePaneChrome}
            paletteBg={paletteBg}
            paletteSelectedBg={paletteSelectedBg}
            paletteSubtleText={paletteSubtleText}
            paletteText={paletteText}
            panelBg={panelBg}
            queryDisplayWidth={queryDisplayWidth}
            themeBorder={themeColors.border}
            themeBorderFocused={themeColors.borderFocused}
            themeNegative={themeColors.negative}
            themePanel={themeColors.panel}
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
            paletteText={paletteText}
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
            paletteBg={paletteBg}
            panelBg={panelBg}
            onCommit={onMultiSelectCommit}
            onSelect={onMultiSelectSelect}
            onToggle={onMultiSelectToggle}
          />
        )}
      </Box>

      {!nativePaneChrome && <Box flexGrow={1} />}
    </>
  );
}

function getCommandBarPanelTitle(route: CommandBarRoute | null): string {
  if (!route) return "Commands";
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
  paletteText,
  queryDisplayWidth,
  onConfirm,
}: {
  route: CommandBarConfirmRoute;
  bodyHeight: number;
  contentPadding: number;
  paletteText: string;
  queryDisplayWidth: number;
  onConfirm: () => void;
}) {
  const themeColors = useThemeColors();
  return (
    <Box flexDirection="column" height={bodyHeight} paddingX={contentPadding}>
      {route.body.map((line, index) => (
        <Box key={`confirm:${index}`} height={1}>
          <Text fg={paletteText}>{truncateText(t(line), queryDisplayWidth)}</Text>
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
