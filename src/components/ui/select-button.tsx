import { useCallback } from "react";
import { Box, Text, TextAttributes, useUiHost } from "../../ui";
import { type PromptContext, useDialog } from "../../ui/dialog";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { colors } from "../../theme/colors";
import { ChoiceDialog } from "./choice-dialog";
import { NativeSelect } from "./native-select";

export interface SelectButtonOption<T extends string = string> {
  value: T;
  label: string;
  /** Trigger wording when the full label is too wide for a pane header. */
  short?: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectButtonProps<T extends string = string> {
  /** Names the dimension, e.g. "Prem". Shown before the value on the trigger. */
  label: string;
  value: T;
  options: readonly SelectButtonOption<T>[];
  onChange: (value: T) => void;
  /** Dialog title. Defaults to `label`. */
  title?: string;
  disabled?: boolean;
  /**
   * Draws the value as active. Panes pass `value !== default` so a row of
   * selects shows at a glance which ones are narrowing what you are looking at.
   */
  emphasized?: boolean;
  idPrefix?: string;
}

/**
 * Single-select control usable inside a pane body, not just the settings dialog.
 * Desktop gets a real `<select>`; the terminal has no dropdown primitive, so it
 * opens the standard choice dialog, which shows the full option labels instead
 * of making people click a chip repeatedly to discover what the values are.
 */
export function SelectButton<T extends string = string>({
  label,
  value,
  options,
  onChange,
  title,
  disabled = false,
  emphasized = false,
  idPrefix,
}: SelectButtonProps<T>) {
  const isDesktopWeb = useUiHost().kind === "desktop-web";
  const dialog = useDialog();
  const current = options.find((option) => option.value === value);

  const selectValue = useCallback((next: unknown) => {
    const candidate = typeof next === "string" ? next : (next as { value?: string })?.value;
    const match = options.find((option) => option.value === candidate);
    if (!match || match.disabled || match.value === value) return;
    onChange(match.value);
  }, [onChange, options, value]);

  // Same parity as Button and Tabs: the control has to be drivable without a
  // mouse for remote control and UI automation.
  useRemoteUiNode({
    role: "select",
    label,
    disabled,
    actions: { select: selectValue },
    metadata: {
      value,
      options: options.map((option) => ({ value: option.value, label: option.label })),
    },
  });

  const openDialog = useCallback((event?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
    event?.stopPropagation?.();
    event?.preventDefault?.();
    if (disabled) return;
    void dialog.prompt<string>({
      closeOnClickOutside: true,
      content: (context: PromptContext<string>) => (
        <ChoiceDialog
          {...context}
          title={title ?? label}
          selectedChoiceId={value}
          choices={options.map((option) => ({
            id: option.value,
            label: option.label,
            description: option.description,
            disabled: option.disabled,
          }))}
        />
      ),
    }).then((next) => {
      if (!next) return;
      const match = options.find((option) => option.value === next);
      if (match && !match.disabled) onChange(match.value);
    }).catch(() => {});
  }, [dialog, disabled, label, onChange, options, title, value]);

  if (isDesktopWeb) {
    return (
      <Box flexDirection="row" alignItems="center" gap={1} id={idPrefix ? `${idPrefix}:select` : undefined}>
        <Text fg={colors.textMuted}>{label}</Text>
        <NativeSelect
          variant="inline"
          value={value}
          options={options.map((option) => ({
            value: option.value,
            label: option.label,
            disabled: option.disabled,
          }))}
          onChange={(next) => {
            if (next !== value) onChange(next as T);
          }}
        />
      </Box>
    );
  }

  return (
    <Box
      id={idPrefix ? `${idPrefix}:select` : undefined}
      height={1}
      flexDirection="row"
      onMouseDown={openDialog}
    >
      <Text fg={colors.textMuted} onMouseDown={openDialog}>{`${label} `}</Text>
      <Text
        fg={disabled ? colors.textMuted : emphasized ? colors.textBright : colors.text}
        attributes={emphasized ? TextAttributes.BOLD : undefined}
        onMouseDown={openDialog}
      >
        {current?.short ?? current?.label ?? ""}
      </Text>
    </Box>
  );
}
