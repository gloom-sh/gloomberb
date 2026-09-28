import { useEffect, useRef, type RefObject } from "react";
import { matchesKeybindingAction, useKeybindings, type KeyChordEventLike } from "../../app/keybindings";
import { t } from "../../i18n";
import { useRemoteUiNode } from "../../remote/semantic-tree";
import { useThemeColors } from "../../theme/theme-context";
import {
  Box,
  Text,
  TextAttributes,
  Textarea,
  type InputRenderable,
  type TextareaRenderable,
} from "../../ui";
import {
  coerceFieldBoolean,
  coerceFieldString,
  getWorkflowFieldDescription,
  summarizeWorkflowFieldValue,
} from "../command-bar/workflow/fields";
import type { CommandBarFieldValue, CommandBarWorkflowField } from "../command-bar/workflow/types";
import { TERMINAL_MESSAGE_KEYS } from "../textarea-keys";
import { Checkbox } from "../ui/checkbox";
import { NumberField, TextField } from "../ui/fields";
import { SelectField, type SelectFieldHandle } from "../ui/select-field";
import { FORM_TEXTAREA_ROWS } from "./model";

export interface FormFieldRowProps {
  field: CommandBarWorkflowField;
  value: CommandBarFieldValue | undefined;
  active: boolean;
  /** Whether the field's input holds the keyboard: active, not pending, no dialog above. */
  inputFocused: boolean;
  /**
   * Bumped when the form wants the active input focused again, after a click
   * that moved the focus but not the form's (a label, the button that found
   * the field empty). `focused` alone does not, as it has not changed.
   */
  focusRequest: number;
  pending: boolean;
  desktop: boolean;
  isLast: boolean;
  rowId: string;
  /** Bumped when a value arrives from outside the textarea, which then starts over from it. */
  textareaRevision: number;
  onFocus: () => void;
  onOpen: () => void;
  onChange: (value: CommandBarFieldValue) => void;
  /** Enter on a text field: the next field, or the form on the last one. */
  onSubmitField: () => void;
  onPicked: () => void;
  onSelectRef: (handle: SelectFieldHandle | null) => void;
  remote: {
    setValue: (input: unknown) => void;
    submit: () => void;
  };
}

type KeyLike = KeyChordEventLike & { preventDefault?: () => void };

function FormTextarea({
  field,
  value,
  focused,
  desktop,
  textareaRef,
  onChange,
  onSubmitField,
}: {
  field: CommandBarWorkflowField;
  value: string;
  focused: boolean;
  desktop: boolean;
  textareaRef: RefObject<TextareaRenderable | null>;
  onChange: (value: string) => void;
  onSubmitField: () => void;
}) {
  const colors = useThemeColors();
  const keybindings = useKeybindings();
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // The terminal textarea reports edits through `onContentChange`, the DOM one
  // through `onInput`; either way the form holds the text, not the buffer.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.onContentChange = () => {
      try {
        onChangeRef.current(textarea.editBuffer.getText());
      } catch {
        // The buffer can go away with the dialog.
      }
    };
    return () => {
      textarea.onContentChange = undefined;
    };
  }, [textareaRef]);

  // A DOM textarea submits on plain Enter whenever it has `onSubmit`, so on
  // desktop it gets none and Shift+Enter (or Alt/Cmd+Enter) moves on here.
  const submitOnModifiedEnter = (event: KeyLike) => {
    if (event.name !== "return" || !(event.shift || event.alt || event.meta)) return;
    // That chord acts on the newest toast; it must not also send the form.
    if (matchesKeybindingAction(keybindings, "notification-action", event)) return;
    event.preventDefault?.();
    onSubmitField();
  };

  return (
    <Box
      height={FORM_TEXTAREA_ROWS}
      border={!desktop}
      borderColor={focused ? colors.borderFocused : colors.border}
      backgroundColor={colors.panel}
      {...(desktop ? {
        style: {
          border: `1px solid ${focused ? colors.borderFocused : colors.border}`,
          borderRadius: 6,
          overflow: "hidden",
        },
      } : {})}
    >
      {/* The row's form-field node sets this value, and starts the textarea over from it. */}
      <Textarea
        ref={textareaRef}
        data-gloom-remote-hidden
        initialValue={value}
        placeholder={field.placeholder ? t(field.placeholder) : ""}
        focused={focused}
        textColor={colors.text}
        placeholderColor={colors.textDim}
        backgroundColor={colors.panel}
        flexGrow={1}
        wrapText
        {...(desktop
          ? { style: { padding: "6px 8px", lineHeight: "18px" }, onKeyDown: submitOnModifiedEnter }
          : { keyBindings: TERMINAL_MESSAGE_KEYS, onSubmit: onSubmitField })}
        onInput={(nextValue: string) => onChange(nextValue)}
      />
    </Box>
  );
}

export function FormFieldRow({
  field,
  value,
  active,
  inputFocused,
  focusRequest,
  pending,
  desktop,
  isLast,
  rowId,
  textareaRevision,
  onFocus,
  onOpen,
  onChange,
  onSubmitField,
  onPicked,
  onSelectRef,
  remote,
}: FormFieldRowProps) {
  const colors = useThemeColors();
  const label = t(field.label);
  const description = getWorkflowFieldDescription(field);
  const placeholder = field.placeholder ? t(field.placeholder) : undefined;
  const usesDropdown = desktop && field.type === "select";
  const opensPicker = !usesDropdown && (field.type === "select" || field.type === "multi-select" || field.type === "ordered-multi-select");
  // The terminal draws inputs on the panel colour so they read as fields on the dialog's background.
  const inputBg = desktop ? undefined : colors.panel;
  const inputRef = useRef<InputRenderable | null>(null);
  const textareaRef = useRef<TextareaRenderable | null>(null);

  useEffect(() => {
    if (focusRequest === 0 || !inputFocused) return;
    // After the focus change the pointer makes once its mousedown handlers ran.
    const timer = setTimeout(() => (textareaRef.current ?? inputRef.current)?.focus?.(), 0);
    return () => clearTimeout(timer);
  }, [focusRequest, inputFocused]);

  useRemoteUiNode({
    role: "form-field",
    label,
    disabled: pending,
    actions: {
      focus: onFocus,
      setValue: remote.setValue,
      submit: remote.submit,
    },
    metadata: {
      scope: "form",
      fieldId: field.id,
      fieldType: field.type,
      required: field.required === true,
      active,
      value: value ?? null,
      summary: summarizeWorkflowFieldValue(field, value),
      ...("options" in field ? { options: field.options.map((option) => ({ value: option.value, label: option.label })) } : {}),
    },
  });

  const control = (() => {
    switch (field.type) {
      case "number":
        return (
          <NumberField
            value={coerceFieldString(value)}
            placeholder={placeholder}
            focused={inputFocused}
            inputRef={inputRef}
            backgroundColor={inputBg}
            onChange={(nextValue) => onChange(nextValue)}
            onSubmit={onSubmitField}
          />
        );
      case "text":
      case "password":
        return (
          <TextField
            type={field.type === "password" ? "password" : "text"}
            value={coerceFieldString(value)}
            placeholder={placeholder}
            focused={inputFocused}
            inputRef={inputRef}
            backgroundColor={inputBg}
            onChange={(nextValue) => onChange(nextValue)}
            onSubmit={onSubmitField}
          />
        );
      case "textarea":
        return (
          <FormTextarea
            key={textareaRevision}
            field={field}
            value={coerceFieldString(value)}
            focused={inputFocused}
            desktop={desktop}
            textareaRef={textareaRef}
            onChange={onChange}
            onSubmitField={onSubmitField}
          />
        );
      case "toggle":
        return (
          <Checkbox
            label={label}
            displayLabel=""
            checked={coerceFieldBoolean(value)}
            active={active}
            disabled={pending}
            onChange={(checked) => {
              // The checkbox keeps its mousedown from the row, so a click makes it active here.
              onFocus();
              onChange(checked);
            }}
          />
        );
      case "select":
        if (usesDropdown) {
          return (
            <SelectField
              disabled={pending}
              value={coerceFieldString(value)}
              options={field.options.map((option) => ({
                ...option,
                label: t(option.label),
                description: option.description ? t(option.description) : undefined,
              }))}
              width="100%"
              restoreFocus={false}
              selectRef={onSelectRef}
              onFocus={onFocus}
              onChange={(nextValue) => {
                onChange(nextValue);
                onPicked();
              }}
            />
          );
        }
        break;
      default:
        break;
    }
    return (
      <Box
        height={1}
        backgroundColor={inputBg}
        onMouseDown={(event: { stopPropagation?: () => void }) => {
          event.stopPropagation?.();
          onFocus();
          if (!pending) onOpen();
        }}
        {...(desktop ? { style: { border: `1px solid ${active ? colors.borderFocused : colors.border}`, borderRadius: 6, padding: "0 7px" } } : {})}
      >
        <Text fg={active ? colors.text : colors.textDim}>{t(summarizeWorkflowFieldValue(field, value))}</Text>
      </Box>
    );
  })();

  return (
    <Box
      id={rowId}
      flexDirection="column"
      {...(!desktop ? { marginBottom: isLast ? 0 : 1 } : { style: { marginBottom: isLast ? 0 : 12 } })}
      onMouseDown={() => {
        onFocus();
        if (opensPicker && !pending) onOpen();
      }}
    >
      <Box height={1}>
        <Text fg={active ? colors.text : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
          {label}
        </Text>
      </Box>
      {control}
      {description && (
        <Text fg={colors.textMuted} wrapText>{t(description)}</Text>
      )}
    </Box>
  );
}
