import type { RefObject } from "react";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { colors } from "../../../theme/colors";
import { t, tf } from "../../../i18n";
import type { BrokerConfigField } from "../../../types/broker";
import { TextField, type ListViewItem } from "../../ui";
import { formatBrokerFieldValue, getBrokerLabel } from "./utils";

export function BrokerFieldsPanel({
  choices,
  selectedBrokerId,
  brokerFields,
  brokerFieldIdx,
  brokerSelectIdx,
  brokerValues,
  onBrokerFieldChange,
  editing,
  inputRef,
}: {
  choices: ListViewItem[];
  selectedBrokerId: string;
  brokerFields: BrokerConfigField[];
  brokerFieldIdx: number;
  brokerSelectIdx: number;
  brokerValues: Record<string, Record<string, string>>;
  onBrokerFieldChange: (brokerId: string, key: string, value: string) => void;
  editing: boolean;
  inputRef: RefObject<InputRenderable | null>;
}) {
  const values = brokerValues[selectedBrokerId] ?? {};

  return (
    <Box flexDirection="column" paddingX={2}>
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {t("Connect ")}{getBrokerLabel(choices, selectedBrokerId)}
        </Text>
      </Box>
      <Box height={1} />

      {brokerFields.map((field, index) => {
        if (index > brokerFieldIdx) return null;
        const value = values[field.key] ?? "";
        const isActive = index === brokerFieldIdx;

        if (!isActive && value) {
          return (
            <Box key={field.key} height={1} flexDirection="row">
              <Text fg={colors.positive}>{"\u2713 "}</Text>
              <Text fg={colors.text}>{`${field.label}: ${formatBrokerFieldValue(field, value)}`}</Text>
            </Box>
          );
        }

        if (isActive) {
          const activeSelectValue = field.options?.[brokerSelectIdx]?.value ?? values[field.key] ?? "";
          const effectiveValue = value || field.defaultValue || "";
          return (
            <Box key={field.key} flexDirection="column">
              {index > 0 && <Box height={1} />}
              <Box height={1} flexDirection="row">
                <Text fg={colors.text} attributes={TextAttributes.BOLD}>
                  {tf("Step {step}: ", { step: index + 1 })}
                </Text>
                <Text fg={colors.text}>{t(field.label)}</Text>
              </Box>
              <Box height={1}>
                {field.type !== "select" && (editing ? (
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
                    onSubmit={() => {}}
                  />
                ) : (
                  <Text fg={effectiveValue ? colors.positive : colors.textMuted}>
                    {effectiveValue
                      ? `\u2713 ${t(field.label)}: ${formatBrokerFieldValue(field, effectiveValue)}`
                      : t("Press enter to type...")}
                  </Text>
                ))}
              </Box>
              {field.type !== "select" && !value && field.defaultValue && (
                <Box height={1}>
                  <Text fg={colors.textMuted}>{tf("Press enter to use {value}", { value: field.defaultValue })}</Text>
                </Box>
              )}
              {field.type === "select" && (
                <Box flexDirection="column">
                  {(field.options ?? []).map((option, optionIdx) => {
                    const selected = optionIdx === brokerSelectIdx;
                    return (
                      <Box key={option.value} flexDirection="column" backgroundColor={selected ? colors.selected : colors.bg}>
                        <Box height={1} flexDirection="row">
                          <Text fg={selected ? colors.selectedText : colors.textDim}>{selected ? "\u25b8 " : "  "}</Text>
                          <Text
                            fg={selected ? colors.text : colors.textDim}
                            attributes={selected ? TextAttributes.BOLD : 0}
                          >
                            {t(option.label)}
                          </Text>
                        </Box>
                        {option.description && (
                          <Box height={1}>
                            <Text fg={colors.textMuted}>{`  ${t(option.description)}`}</Text>
                          </Box>
                        )}
                      </Box>
                    );
                  })}
                </Box>
              )}
              {field.type === "select" && (
                <Box height={1}>
                  <Text fg={colors.textMuted}>
                    {activeSelectValue
                      ? tf("Selected: {value}", { value: t(field.options?.find((option) => option.value === activeSelectValue)?.label ?? activeSelectValue) })
                      : t("Use \u2191\u2193 to choose")}
                  </Text>
                </Box>
              )}
            </Box>
          );
        }

        return null;
      })}

      <Box height={2} />
      <Box height={1}>
        <Text fg={colors.textDim}>{t("Credentials are saved locally.")}</Text>
      </Box>
      <Box height={1} />
      <Box height={1}>
        <Text fg={colors.textMuted}>
          {tf("Field {current} of {total}", { current: brokerFieldIdx + 1, total: brokerFields.length })}
        </Text>
      </Box>
    </Box>
  );
}
