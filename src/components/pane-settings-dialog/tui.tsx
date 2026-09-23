import { Box, Text } from "../../ui";
import { t } from "../../i18n";
import { TextAttributes } from "../../ui";
import type { PaneSettingField } from "../../types/plugin";
import { colors } from "../../theme/colors";
import { useViewport } from "../../react/input";
import { DialogFrame, ListView } from "../ui";
import type { ListViewProps } from "../ui/list-view";
import { isPaneSettingDisabled, summarizePaneSettingValue } from "./value";

/** Terminal rows a settings dialog spends around its list: edge, frame, title, description. */
const TUI_DIALOG_LIST_CHROME_ROWS = 11;

/** The most list rows a terminal settings dialog shows before the list scrolls. */
export function useTuiDialogListRows(): number {
  return Math.max(3, useViewport().height - TUI_DIALOG_LIST_CHROME_ROWS);
}

/**
 * A list in a terminal settings dialog. Past the rows the terminal has room
 * for it scrolls to the cursor instead of running under the dialog's edge,
 * and the highlighted row's description sits under it.
 */
export function TuiDialogList(props: ListViewProps) {
  const maxRows = useTuiDialogListRows();
  const scrollable = props.items.length > maxRows;
  const description = props.selectedIndex >= 0 ? props.items[props.selectedIndex]?.description : undefined;
  return (
    <>
      <ListView
        {...props}
        scrollable={scrollable}
        height={scrollable ? maxRows : undefined}
        showSelectedDescription={false}
      />
      {description && (
        <>
          <Box height={1} />
          <Box>
            <Text fg={colors.textDim}>{"    "}{t(description)}</Text>
          </Box>
        </>
      )}
    </>
  );
}

export function TuiUnavailablePaneSettingsDialog() {
  return (
    <DialogFrame title={t("Pane Settings")} footer={t("Press esc to cancel")}>
      <Text fg={colors.textDim}>{t("This pane is no longer configurable.")}</Text>
    </DialogFrame>
  );
}

export function TuiPaneSettingsDialogBody({
  title,
  fields,
  selectedIndex,
  settings,
  onSelect,
  onActivate,
}: {
  title: string;
  fields: PaneSettingField[];
  selectedIndex: number;
  settings: Record<string, unknown>;
  onSelect: (index: number) => void;
  onActivate: (field: PaneSettingField | undefined) => void;
}) {
  return (
    <DialogFrame title={t(title)}>
      <TuiDialogList
        items={fields.map((field) => ({
          id: field.key,
          label: t(field.label),
          description: field.description ? t(field.description) : field.description,
          detail: summarizePaneSettingValue(field, settings[field.key]),
          disabled: isPaneSettingDisabled(field),
        }))}
        selectedIndex={selectedIndex}
        bgColor={colors.commandBg}
        onSelect={onSelect}
        onActivate={(_, index) => {
          onActivate(fields[index]);
        }}
        renderRow={(item, rowState) => (
          <Box flexDirection="row" justifyContent="space-between" width="100%">
            <Box flexDirection="row">
              <Text fg={rowState.selected ? colors.selectedText : colors.textDim}>
                {rowState.selected ? "▸ " : "  "}
              </Text>
              <Text
                fg={rowState.disabled ? colors.textMuted : rowState.selected ? colors.text : colors.textDim}
                attributes={rowState.selected && !rowState.disabled ? TextAttributes.BOLD : 0}
              >
                {item.label}
              </Text>
            </Box>
            <Text fg={colors.textMuted}>
              {item.detail}
            </Text>
          </Box>
        )}
      />
      {fields.length === 0 && (
        <Box height={1}>
          <Text fg={colors.textDim}>{t("No settings available.")}</Text>
        </Box>
      )}
    </DialogFrame>
  );
}
