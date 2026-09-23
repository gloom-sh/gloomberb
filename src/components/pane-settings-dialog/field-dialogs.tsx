import { Box, Text, useUiHost } from "../../ui";
import { t } from "../../i18n";
import { type AlertContext, useDialogKeyboard } from "../../ui/dialog";
import { useEffect, useRef, useState } from "react";
import type {
  PaneSettingField,
  PaneSettingTextField,
} from "../../types/plugin";
import { colors } from "../../theme/colors";
import { Button, DialogFrame, MultiSelectDialogContent, TextField } from "../ui";
import { listCursorMove } from "../ui/list-view";
import { DesktopDialogSurface, desktopText } from "./desktop";
import { TuiDialogList, useTuiDialogListRows } from "./tui";
import { coerceSelectedPaneSettingValues, isSpaceKey } from "./value";

type SelectPaneSettingField = Extract<PaneSettingField, { type: "select" }>;
type MultiSelectPaneSettingField = Extract<PaneSettingField, { type: "multi-select" | "ordered-multi-select" }>;

interface SelectFieldDialogProps extends AlertContext {
  field: SelectPaneSettingField;
  currentValue: unknown;
  onApply: (value: string) => Promise<void>;
}

interface TextFieldDialogProps extends AlertContext {
  field: PaneSettingTextField;
  currentValue: unknown;
  onApply: (value: string) => Promise<void>;
}

function useSelectFieldDialogController({
  dismiss,
  field,
  currentValue,
  onApply,
}: SelectFieldDialogProps) {
  const initialIndex = Math.max(0, field.options.findIndex((option) => option.value === currentValue));
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const pageSize = useTuiDialogListRows() - 1;

  const applyOption = (value: string) => {
    void onApply(value).then(() => dismiss()).catch(() => {});
  };

  useDialogKeyboard((event) => {
    event.stopPropagation();
    const move = listCursorMove(event, pageSize);
    if (move) setSelectedIndex((index) => move(field.options, index));
    else if (event.name === "escape") dismiss();
    else if (event.name === "enter" || event.name === "return" || isSpaceKey(event)) {
      const option = field.options[selectedIndex];
      if (!option) return;
      applyOption(option.value);
    }
  });

  return { selectedIndex, setSelectedIndex, applyOption };
}

export function TuiSelectFieldDialog(props: SelectFieldDialogProps) {
  const { field } = props;
  const { selectedIndex, setSelectedIndex, applyOption } = useSelectFieldDialogController(props);

  return (
    <DialogFrame
      title={field.label}
    >
      <TuiDialogList
        items={field.options.map((option) => ({
          id: option.value,
          label: option.label,
          description: option.description,
        }))}
        selectedIndex={selectedIndex}
        bgColor={colors.commandBg}
        onSelect={setSelectedIndex}
        onActivate={(item) => {
          applyOption(item.id);
        }}
      />
    </DialogFrame>
  );
}

function useTextFieldDialogController({
  dismiss,
  currentValue,
  onApply,
}: TextFieldDialogProps) {
  const [value, setValue] = useState(typeof currentValue === "string" ? currentValue : "");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  useDialogKeyboard((event) => {
    if (event.name === "escape") {
      event.stopPropagation();
      dismiss();
    }
  }, { allowEditable: true });

  const submit = async () => {
    try {
      setError(null);
      await onApply(value);
      dismiss();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save this value."));
    }
  };

  return { value, setValue, error, inputRef, submit };
}

export function TextFieldDialog(props: TextFieldDialogProps) {
  return useUiHost().kind === "desktop-web"
    ? <DesktopTextFieldDialog {...props} />
    : <TuiTextFieldDialog {...props} />;
}

function DesktopTextFieldDialog(props: TextFieldDialogProps) {
  const { dismiss, field } = props;
  const { value, setValue, error, inputRef, submit } = useTextFieldDialogController(props);

  return (
    <DesktopDialogSurface
      title={field.label}
      subtitle={field.description}
      dismiss={dismiss}
    >
      <Box flexDirection="column" gap={1}>
        <TextField
          inputRef={inputRef}
          value={value}
          placeholder={field.placeholder}
          focused
          width={56}
          onChange={setValue}
          onSubmit={() => { void submit(); }}
        />
        {error && (
          <Text fg={colors.negative} wrapText style={desktopText(600)}>{error}</Text>
        )}
        <Box flexDirection="row" justifyContent="flex-end" style={{ marginTop: 12 }}>
          <Button label={t("Save")} variant="primary" onPress={() => { void submit(); }} />
        </Box>
      </Box>
    </DesktopDialogSurface>
  );
}

function TuiTextFieldDialog(props: TextFieldDialogProps) {
  const { dismiss, field } = props;
  const { value, setValue, error, inputRef, submit } = useTextFieldDialogController(props);

  return (
    <DialogFrame
      title={field.label}
    >
      <Box flexDirection="column" gap={1}>
        <TextField
          inputRef={inputRef}
          value={value}
          placeholder={field.placeholder}
          focused
          onChange={setValue}
          onSubmit={() => { void submit(); }}
        />
        {error && (
          <Box height={1}>
            <Text fg={colors.negative}>{error}</Text>
          </Box>
        )}
        {field.description && (
          <Box height={1}>
            <Text fg={colors.textDim}>{field.description}</Text>
          </Box>
        )}
        <Box flexDirection="row" gap={1}>
          <Button label={t("Apply")} variant="primary" onPress={() => { void submit(); }} />
          <Button label={t("Cancel")} variant="ghost" onPress={dismiss} />
        </Box>
      </Box>
    </DialogFrame>
  );
}

export function MultiSelectFieldDialog({
  dismiss,
  dialogId,
  field,
  currentValue,
  onApply,
}: AlertContext & {
  field: MultiSelectPaneSettingField;
  currentValue: unknown;
  onApply: (value: string[]) => Promise<void>;
}) {
  return (
    <MultiSelectDialogContent
      dismiss={dismiss}
      dialogId={dialogId}
      title={field.label}
      options={field.options}
      selectedValues={coerceSelectedPaneSettingValues(currentValue)}
      onChange={onApply}
      ordered={field.type === "ordered-multi-select"}
    />
  );
}
