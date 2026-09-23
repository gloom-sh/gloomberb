import type { RefObject } from "react";
import { t } from "../../../i18n";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import {
  Box,
  Text,
  TextAttributes,
  Textarea,
  type InputRenderable,
  type TextareaRenderable,
} from "../../../ui";
import { NumberField, TextField } from "../../ui";
import { SelectField, type SelectFieldHandle } from "../../ui/select-field";
import {
  coerceFieldString,
  getWorkflowFieldDescription,
  isWorkflowTextField,
  summarizeWorkflowFieldValue,
} from "../helpers";
import { useCommandBarPalette } from "../panel/palette";
import { truncateText } from "../view-model";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";

interface CommandBarWorkflowFieldRowProps {
  route: CommandBarWorkflowRoute;
  field: CommandBarWorkflowField;
  isLastField: boolean;
  nativePaneChrome: boolean;
  queryDisplayWidth: number;
  getWorkflowInputRef: (fieldId: string) => RefObject<InputRenderable | TextareaRenderable | null>;
  onActiveTextareaSync: (route: CommandBarWorkflowRoute) => void;
  onFieldFocus: (fieldId: string) => void;
  onFieldPickerOpen: (route: CommandBarWorkflowRoute, field: CommandBarWorkflowField) => void;
  onFieldValueChange: (fieldId: string, value: CommandBarFieldValue) => void;
  onMoveFieldFocus: (delta: number) => void;
  onSelectFieldRef: (fieldId: string, element: SelectFieldHandle | null) => void;
  onSubmit: (route: CommandBarWorkflowRoute) => void | Promise<void>;
}

export function CommandBarWorkflowFieldRow({
  route,
  field,
  isLastField,
  nativePaneChrome,
  queryDisplayWidth,
  getWorkflowInputRef,
  onActiveTextareaSync,
  onFieldFocus,
  onFieldPickerOpen,
  onFieldValueChange,
  onMoveFieldFocus,
  onSelectFieldRef,
  onSubmit,
}: CommandBarWorkflowFieldRowProps) {
  const palette = useCommandBarPalette(nativePaneChrome);
  const active = field.id === route.activeFieldId;
  const value = route.values[field.id];
  const borderColor = active ? palette.selectedBg : palette.bg;
  const fieldBg = nativePaneChrome ? "transparent" : active ? palette.inputBg : palette.panelBg;
  const useSelectField = nativePaneChrome && field.type === "select";
  const fieldDescription = getWorkflowFieldDescription(field);
  const fieldLabel = t(field.label);
  const translatedFieldDescription = fieldDescription ? t(fieldDescription) : null;
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
    if (!isWorkflowTextField(field) && !useSelectField) {
      onFieldPickerOpen(route, field);
    }
  };

  useRemoteUiNode({
    role: "command-bar-field",
    label: fieldLabel,
    disabled: route.pending,
    actions: {
      focus: focusOrOpenField,
      open: !isWorkflowTextField(field) && !useSelectField ? focusOrOpenField : undefined,
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
        <Text fg={active ? palette.text : palette.subtle} attributes={active ? TextAttributes.BOLD : 0}>
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
            backgroundColor={nativePaneChrome ? palette.inputBg : fieldBg}
            onChange={(nextValue) => onFieldValueChange(field.id, nextValue)}
            onSubmit={submitOrMoveNext}
          />
        ) : field.type === "textarea" ? (
          <Box
            minHeight={6}
            height={6}
            border={!nativePaneChrome}
            borderColor={active ? palette.selectedBg : palette.bg}
            backgroundColor={nativePaneChrome ? palette.inputBg : fieldBg}
            style={nativePaneChrome ? {
              border: `1px solid ${active ? palette.borderFocused : palette.border}`,
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
                textColor={palette.text}
                placeholderColor={palette.subtle}
                backgroundColor={nativePaneChrome ? palette.inputBg : palette.panel}
                flexGrow={1}
                wrapText
              />
            ) : (
              <Box flexDirection="column" paddingX={1} paddingY={0}>
                {buildTextareaPreviewLines(coerceFieldString(value), field.placeholder ? t(field.placeholder) : undefined, queryDisplayWidth).map((line, index) => (
                  <Box key={`${field.id}:preview:${index}`} height={1}>
                    <Text fg={coerceFieldString(value).trim() ? palette.text : palette.subtle}>{line || " "}</Text>
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
            backgroundColor={nativePaneChrome ? palette.inputBg : fieldBg}
            onChange={(nextValue) => onFieldValueChange(field.id, nextValue)}
            onSubmit={submitOrMoveNext}
          />
        )
      ) : useSelectField ? (
        <SelectField
          disabled={route.pending}
          value={coerceFieldString(value)}
          options={field.options.map((option) => ({
            ...option,
            label: t(option.label),
            description: option.description ? t(option.description) : undefined,
          }))}
          width="100%"
          selectRef={(element) => onSelectFieldRef(field.id, element)}
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
          <Text fg={active ? palette.text : palette.subtle}>
            {truncateText(t(summarizeWorkflowFieldValue(field, value)), queryDisplayWidth)}
          </Text>
        </Box>
      )}
      {translatedFieldDescription && (
        <Box height={1}>
          <Text fg={palette.subtle}>
            {truncateText(translatedFieldDescription, queryDisplayWidth)}
          </Text>
        </Box>
      )}
    </Box>
  );
}

function buildTextareaPreviewLines(value: string, placeholder: string | undefined, queryDisplayWidth: number): string[] {
  const preview = value.trim();
  return (preview || placeholder || t("Unset"))
    .split("\n")
    .flatMap((line) => line.match(new RegExp(`.{1,${Math.max(1, queryDisplayWidth - 8)}}`, "g")) ?? [""])
    .slice(0, 4);
}
