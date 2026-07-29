import type { RefObject } from "react";
import { t } from "../../../i18n";
import {
  Box,
  Text,
  Textarea,
  TextAttributes,
  type InputRenderable,
  type TextareaRenderable,
} from "../../../ui";
import { NumberField, TextField } from "../../ui";
import { NativeSelect, type NativeSelectElement } from "../../ui/native-select";
import {
  coerceFieldString,
  getWorkflowFieldDescription,
  isWorkflowTextField,
  summarizeWorkflowFieldValue,
} from "../helpers";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";
import { truncateText } from "../view-model";

interface CommandBarWorkflowFieldRowProps {
  route: CommandBarWorkflowRoute;
  field: CommandBarWorkflowField;
  isLastField: boolean;
  inputBg: string;
  nativePaneChrome: boolean;
  paletteBg: string;
  paletteSelectedBg: string;
  paletteSubtleText: string;
  paletteText: string;
  panelBg: string;
  queryDisplayWidth: number;
  themeBorder: string;
  themeBorderFocused: string;
  themePanel: string;
  getWorkflowInputRef: (fieldId: string) => RefObject<InputRenderable | TextareaRenderable | null>;
  onActiveTextareaSync: (route: CommandBarWorkflowRoute) => void;
  onFieldFocus: (fieldId: string) => void;
  onFieldPickerOpen: (route: CommandBarWorkflowRoute, field: CommandBarWorkflowField) => void;
  onFieldValueChange: (fieldId: string, value: CommandBarFieldValue) => void;
  onMoveFieldFocus: (delta: number) => void;
  onNativeSelectRef: (fieldId: string, element: NativeSelectElement | null) => void;
  onSubmit: (route: CommandBarWorkflowRoute) => void | Promise<void>;
}

export function CommandBarWorkflowFieldRow({
  route,
  field,
  isLastField,
  inputBg,
  nativePaneChrome,
  paletteBg,
  paletteSelectedBg,
  paletteSubtleText,
  paletteText,
  panelBg,
  queryDisplayWidth,
  themeBorder,
  themeBorderFocused,
  themePanel,
  getWorkflowInputRef,
  onActiveTextareaSync,
  onFieldFocus,
  onFieldPickerOpen,
  onFieldValueChange,
  onMoveFieldFocus,
  onNativeSelectRef,
  onSubmit,
}: CommandBarWorkflowFieldRowProps) {
  const active = field.id === route.activeFieldId;
  const value = route.values[field.id];
  const borderColor = active ? paletteSelectedBg : paletteBg;
  const fieldBg = nativePaneChrome ? "transparent" : active ? inputBg : panelBg;
  const useNativeSelect = nativePaneChrome && field.type === "select";
  const fieldDescription = getWorkflowFieldDescription(field, active);
  const fieldLabel = t(field.label);
  const translatedFieldDescription = translateWorkflowFieldDescription(fieldDescription);
  const submitOrMoveNext = () => {
    if (isLastField) {
      void onSubmit(route);
    } else {
      onMoveFieldFocus(1);
    }
  };
  const focusOrOpenField = () => {
    onActiveTextareaSync(route);
    onFieldFocus(field.id);
    if (!isWorkflowTextField(field) && !useNativeSelect) {
      onFieldPickerOpen(route, field);
    }
  };

  useRemoteUiNode({
    role: "command-bar-field",
    label: fieldLabel,
    disabled: route.pending,
    actions: {
      focus: focusOrOpenField,
      open: !isWorkflowTextField(field) && !useNativeSelect ? focusOrOpenField : undefined,
      submit: () => void onSubmit(route),
    },
    metadata: {
      scope: "command-bar",
      surface: "workflow",
      routeTitle: t(route.title),
      fieldId: field.id,
      fieldType: field.type,
      active,
      value: summarizeWorkflowFieldValue(field, value),
      description: translatedFieldDescription,
    },
  });

  return (
    <Box
      key={field.id}
      flexDirection="column"
      {...(!nativePaneChrome ? { marginBottom: isLastField ? 0 : 1 } : {})}
      backgroundColor={fieldBg}
      onMouseDown={(event: any) => {
        event.stopPropagation?.();
        focusOrOpenField();
      }}
      style={nativePaneChrome ? {
        marginBottom: isLastField ? 8 : 10,
        paddingBlock: 3,
      } : undefined}
    >
      <Box height={1}>
        <Text fg={active ? paletteText : paletteSubtleText} attributes={active ? TextAttributes.BOLD : 0}>
          {fieldLabel}
        </Text>
      </Box>
      {isWorkflowTextField(field) ? (
        field.type === "number" ? (
          <NumberField
            inputRef={getWorkflowInputRef(field.id) as RefObject<InputRenderable | null>}
            value={coerceFieldString(value)}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            focused={active && !route.pending}
            variant="default"
            backgroundColor={nativePaneChrome ? inputBg : fieldBg}
            onChange={(nextValue) => onFieldValueChange(field.id, nextValue)}
            onSubmit={submitOrMoveNext}
          />
        ) : field.type === "textarea" ? (
          <Box
            minHeight={6}
            height={6}
            border={!nativePaneChrome}
            borderColor={active ? paletteSelectedBg : paletteBg}
            backgroundColor={nativePaneChrome ? inputBg : fieldBg}
            style={nativePaneChrome ? {
              border: `1px solid ${active ? themeBorderFocused : themeBorder}`,
              borderRadius: 6,
              overflow: "hidden",
            } : undefined}
          >
            {active ? (
              <Textarea
                key={field.id}
                ref={getWorkflowInputRef(field.id) as RefObject<TextareaRenderable | null>}
                initialValue={coerceFieldString(value)}
                placeholder={field.placeholder ? t(field.placeholder) : ""}
                focused={!route.pending}
                textColor={paletteText}
                placeholderColor={paletteSubtleText}
                backgroundColor={nativePaneChrome ? inputBg : themePanel}
                flexGrow={1}
                wrapText
              />
            ) : (
              <Box flexDirection="column" paddingX={1} paddingY={0}>
                {buildTextareaPreviewLines(coerceFieldString(value), field.placeholder ? t(field.placeholder) : undefined, queryDisplayWidth).map((line, index) => (
                  <Box key={`${field.id}:preview:${index}`} height={1}>
                    <Text fg={coerceFieldString(value).trim() ? paletteText : paletteSubtleText}>{line || " "}</Text>
                  </Box>
                ))}
              </Box>
            )}
          </Box>
        ) : (
          <TextField
            inputRef={getWorkflowInputRef(field.id) as RefObject<InputRenderable | null>}
            type={field.type === "password" ? "password" : "text"}
            value={coerceFieldString(value)}
            placeholder={field.placeholder ? t(field.placeholder) : undefined}
            focused={active && !route.pending}
            variant="default"
            backgroundColor={nativePaneChrome ? inputBg : fieldBg}
            onChange={(nextValue) => onFieldValueChange(field.id, nextValue)}
            onSubmit={submitOrMoveNext}
          />
        )
      ) : useNativeSelect ? (
        <NativeSelect
          value={coerceFieldString(value)}
          options={field.options.map((option) => ({
            ...option,
            label: t(option.label),
            description: option.description ? t(option.description) : undefined,
          }))}
          width="100%"
          selectRef={(element) => onNativeSelectRef(field.id, element)}
          onFocus={() => onFieldFocus(field.id)}
          onChange={(nextValue) => onFieldValueChange(field.id, nextValue)}
        />
      ) : (
        <Box
          height={1}
          backgroundColor={nativePaneChrome ? "transparent" : borderColor}
          onMouseDown={(event: any) => {
            event.stopPropagation?.();
            onFieldPickerOpen(route, field);
          }}
          style={nativePaneChrome ? { borderRadius: 4 } : undefined}
        >
          <Text fg={active ? paletteText : paletteSubtleText}>
            {truncateText(t(summarizeWorkflowFieldValue(field, value)), queryDisplayWidth)}
          </Text>
        </Box>
      )}
      {translatedFieldDescription && (
        <Box height={1}>
          <Text fg={paletteSubtleText}>
            {truncateText(translatedFieldDescription, queryDisplayWidth)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function translateWorkflowFieldDescription(description: string | null): string | null {
  if (!description) return null;
  const submitSuffix = " Ctrl+S submits.";
  return description.endsWith(submitSuffix)
    ? `${t(description.slice(0, -submitSuffix.length))} ${t(submitSuffix.trim())}`
    : t(description);
}

function buildTextareaPreviewLines(value: string, placeholder: string | undefined, queryDisplayWidth: number): string[] {
  const preview = value.trim();
  return (preview || placeholder || t("Unset"))
    .split("\n")
    .flatMap((line) => line.match(new RegExp(`.{1,${Math.max(1, queryDisplayWidth - 8)}}`, "g")) ?? [""])
    .slice(0, 4);
}
