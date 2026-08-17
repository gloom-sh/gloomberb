import type { RefObject } from "react";
import { Box, Text, TextAttributes, useUiHost, type InputRenderable } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import type { BrokerConfigField } from "../../../types/broker";
import { TextField, type ListViewItem } from "../../ui";
import { NativeSelect } from "../../ui/native-select";
import { formatBrokerFieldValue } from "./utils";

export function BrokerFieldsPanel({
  selectedBrokerId,
  brokerFields,
  brokerFieldIdx,
  brokerSelectIdx,
  onBrokerSelect,
  brokerValues,
  onBrokerFieldChange,
  onSubmitBrokerField,
  editing,
  inputRef,
}: {
  choices: ListViewItem[];
  selectedBrokerId: string;
  brokerFields: BrokerConfigField[];
  brokerFieldIdx: number;
  brokerSelectIdx: number;
  onBrokerSelect?: (index: number) => void;
  brokerValues: Record<string, Record<string, string>>;
  onBrokerFieldChange: (brokerId: string, key: string, value: string) => void;
  onSubmitBrokerField?: () => void;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
}) {
  const values = brokerValues[selectedBrokerId] ?? {};
  const desktop = useUiHost().kind === "desktop-web";

  return (
    <Box flexDirection="column" paddingX={desktop ? 0 : 2} style={desktop ? { marginTop: 14 } : undefined}>
      {brokerFields.map((field, index) => {
        if (index > brokerFieldIdx) return null;
        const value = values[field.key] ?? "";
        const isActive = index === brokerFieldIdx;

        if (!isActive && value) {
          return (
            <Box key={field.key} height={1} flexDirection="row" style={desktop ? { marginBottom: 8 } : undefined}>
              <Text fg={colors.positive}>{desktop ? "+ " : "\u2713 "}</Text>
              <Text fg={colors.text}>{`${field.label}: ${formatBrokerFieldValue(field, value)}`}</Text>
            </Box>
          );
        }

        if (isActive) {
          const activeSelectValue = field.options?.[brokerSelectIdx]?.value ?? values[field.key] ?? "";
          const activeSelectOption = field.options?.[brokerSelectIdx];
          const effectiveValue = value || field.defaultValue || "";
          return (
            <Box key={field.key} flexDirection="column">
              {index > 0 && <Box height={1} />}
              <Box height={1} flexDirection="row">
                {!desktop ? (
                  <Text fg={colors.text} attributes={TextAttributes.BOLD}>
                    {tf("Step {step}: ", { step: index + 1 })}
                  </Text>
                ) : null}
                <Text fg={colors.text} attributes={desktop ? TextAttributes.BOLD : 0}>{t(field.label)}</Text>
              </Box>
              {field.type !== "select" ? (
                <Box height={1}>
                  {editing ? (
                  <TextField
                    inputRef={inputRef}
                    value={value}
                    type={field.type === "password" ? "password" : "text"}
                    placeholder={field.placeholder ? t(field.placeholder) : tf("Enter {field}", { field: field.label.toLowerCase() })}
                    focused
                    backgroundColor={colors.panel}
                    textColor={colors.text}
                    placeholderColor={colors.textDim}
                    onChange={(nextValue) => onBrokerFieldChange(selectedBrokerId, field.key, nextValue)}
                    onSubmit={() => onSubmitBrokerField?.()}
                  />
                  ) : (
                    <Text fg={effectiveValue ? colors.positive : colors.textMuted}>
                      {effectiveValue
                        ? `\u2713 ${t(field.label)}: ${formatBrokerFieldValue(field, effectiveValue)}`
                        : t("Press enter to type...")}
                    </Text>
                  )}
                </Box>
              ) : null}
              {field.type !== "select" && !value && field.defaultValue && (
                <Box height={1}>
                  <Text fg={colors.textMuted}>{tf("Press enter to use {value}", { value: field.defaultValue })}</Text>
                </Box>
              )}
              {field.type === "select" && desktop ? (
                <Box style={{ marginTop: 8 }}>
                  <NativeSelect
                    value={activeSelectValue}
                    width="100%"
                    height={32}
                    options={(field.options ?? []).map((option) => ({
                      value: option.value,
                      label: t(option.label),
                      description: option.description ? t(option.description) : undefined,
                    }))}
                    onChange={(nextValue) => {
                      const nextIndex = Math.max(0, field.options?.findIndex((option) => option.value === nextValue) ?? 0);
                      onBrokerSelect?.(nextIndex);
                      onBrokerFieldChange(selectedBrokerId, field.key, nextValue);
                    }}
                  />
                </Box>
              ) : field.type === "select" ? (
                <Box flexDirection="column">
                  {(field.options ?? []).map((option, optionIdx) => {
                    const selected = optionIdx === brokerSelectIdx;
                    return (
                      <Box
                        key={option.value}
                        height={1}
                        flexDirection="column"
                        backgroundColor={selected ? colors.selected : colors.bg}
                        hoverBackgroundColor={selected ? colors.selected : colors.panel}
                        data-gloom-interactive="true"
                        onMouseDown={() => onBrokerSelect?.(optionIdx)}
                        style={{ cursor: "pointer" }}
                      >
                        <Box height={1} flexDirection="row" overflow="hidden">
                          <Text fg={selected ? colors.selectedText : colors.textDim}>{selected ? "\u25b8 " : "  "}</Text>
                          <Text
                            fg={selected ? colors.text : colors.textDim}
                            attributes={selected ? TextAttributes.BOLD : 0}
                          >
                            {t(option.label)}
                          </Text>
                        </Box>
                      </Box>
                    );
                  })}
                  {activeSelectOption?.description ? (
                    <Box height={1} overflow="hidden" paddingLeft={2}>
                      <Text fg={colors.textMuted}>{t(activeSelectOption.description)}</Text>
                    </Box>
                  ) : null}
                </Box>
              ) : null}
              {field.type === "select" && !desktop && (
                <Box height={1} overflow="hidden">
                  <Text fg={colors.textMuted}>{t("Use \u2191\u2193 to choose")}</Text>
                </Box>
              )}
            </Box>
          );
        }

        return null;
      })}

      <Box height={desktop ? undefined : 1} style={desktop ? { marginTop: 16 } : undefined} />
      <Box height={1}>
        <Text fg={colors.textDim}>{t("Credentials are saved locally.")}</Text>
      </Box>
      {!desktop ? (
        <>
          <Box height={1} />
          <Box height={1}>
            <Text fg={colors.textMuted}>
              {tf("Field {current} of {total}", { current: brokerFieldIdx + 1, total: brokerFields.length })}
            </Text>
          </Box>
        </>
      ) : null}
    </Box>
  );
}
