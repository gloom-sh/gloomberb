import { type ReactNode, type Ref } from "react";
import { Checkbox, SelectButton, TextField, type ChoiceDialogChoice } from "../../../components";
import { Box, Text, TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import type { SelectControl } from "../../../components/ui/select-button";
import type { AccountFieldKey, ProfileAnalyticsPreview } from "./model";
import { truncate } from "./model";
import { t } from "../../../i18n";

export function AccountTextField({
  fieldKey,
  label,
  value,
  placeholder,
  activeField,
  focused,
  width,
  type,
  onFocus,
  onChange,
  onSubmit,
}: {
  fieldKey: AccountFieldKey;
  label: string;
  value: string;
  placeholder?: string;
  activeField: AccountFieldKey;
  focused: boolean;
  width: number;
  type?: "text" | "password";
  onFocus: (field: AccountFieldKey) => void;
  onChange: (value: string) => void;
  onSubmit?: () => void;
}) {
  const active = activeField === fieldKey;
  const labelWidth = accountFieldLabelWidth(width);
  const inputWidth = Math.max(8, width - labelWidth - 1);
  const labelText = `${active ? "> " : "  "}${label}`;
  return (
    <Box
      height={1}
      width={width}
      flexDirection="row"
      alignItems="center"
      gap={1}
      onMouseDown={() => onFocus(fieldKey)}
    >
      <Text
        width={labelWidth}
        fg={active ? colors.textBright : colors.textDim}
        attributes={active ? TextAttributes.BOLD : 0}
      >
        {truncate(labelText, labelWidth)}
      </Text>
      <TextField
        value={value}
        placeholder={placeholder}
        focused={focused && active}
        width={inputWidth}
        type={type}
        onChange={onChange}
        onSubmit={onSubmit}
        onMouseDown={() => onFocus(fieldKey)}
      />
    </Box>
  );
}

export function accountFieldLabelWidth(width: number) {
  const preferred = width >= 28 ? 16 : Math.max(10, Math.floor(width * 0.42));
  return Math.max(8, Math.min(preferred, width - 9));
}

export function FieldRow({
  twoColumns,
  children,
}: {
  twoColumns: boolean;
  children: ReactNode;
}) {
  return (
    <Box flexDirection={twoColumns ? "row" : "column"} gap={1}>
      {children}
    </Box>
  );
}

export function CheckboxRow({
  label,
  checked,
  active,
  description,
  width,
  onFocus,
  onChange,
}: {
  label: string;
  checked: boolean;
  active: boolean;
  description?: string;
  width: number;
  onFocus: () => void;
  onChange: (checked: boolean) => void;
}) {
  return <Checkbox label={label} checked={checked} active={active} description={description} width={width} onChange={(next) => { onFocus(); onChange(next); }} />;
}

function metricColor(tone: ProfileAnalyticsPreview["metrics"][number]["tone"]): string {
  if (tone === "positive") return colors.positive;
  if (tone === "negative") return colors.negative;
  if (tone === "muted") return colors.textMuted;
  return colors.text;
}

export function PublicAnalyticsGroup({
  preview,
  choices,
  value,
  detail,
  active,
  width,
  disclaimer,
  controlRef,
  onFocus,
  onSelect,
}: {
  preview: ProfileAnalyticsPreview;
  choices: ChoiceDialogChoice[];
  value: string;
  detail?: string;
  active: boolean;
  width: number;
  disclaimer?: string | null;
  controlRef?: Ref<SelectControl>;
  onFocus: () => void;
  onSelect: (value: string) => void;
}) {
  const contentWidth = Math.max(1, width - 2);
  const labelText = active ? `> ${t("Public Stats:")}` : `  ${t("Public Stats:")}`;
  const labelWidth = Math.min(accountFieldLabelWidth(width), Math.max(1, contentWidth));
  const buttonWidth = Math.max(8, Math.min(24, contentWidth - labelWidth - 1));
  const normalizedDetail = (detail ?? "").replace(/\.+$/, "");
  const displayPreview = (
    preview.metrics.length === 0
    && normalizedDetail
    && preview.subtitle.replace(/\.+$/, "") === normalizedDetail
  ) ? { ...preview, subtitle: "" } : preview;
  const metrics = displayPreview.metrics.slice(0, 2);
  const metricAreaWidth = Math.max(0, contentWidth - labelWidth - buttonWidth - 2);
  const metricWidth = metrics.length > 0 ? Math.max(8, Math.floor((metricAreaWidth - (metrics.length - 1)) / metrics.length)) : 0;
  const detailWidth = Math.max(0, metricAreaWidth);
  return (
    <Box
      flexDirection="column"
      width={width}
      onMouseOver={onFocus}
    >
      <Box height={1} flexDirection="row" gap={1} alignItems="center">
        <Text fg={active ? colors.textBright : colors.textDim} attributes={active ? TextAttributes.BOLD : 0}>
          {truncate(labelText, labelWidth)}
        </Text>
        <SelectButton
          label={t("Public Stats")}
          value={value}
          options={choices.map((choice) => ({ value: choice.id, label: choice.label, description: choice.description, disabled: choice.disabled }))}
          width={buttonWidth}
          variant="field"
          showLabel={false}
          emphasized={active}
          controlRef={controlRef}
          onFocus={onFocus}
          onChange={onSelect}
        />
        {metrics.length > 0 ? metrics.map((metric) => {
          const labelTextWidth = Math.max(1, Math.min(metric.label.length, metricWidth - 2));
          const valueWidth = Math.max(1, metricWidth - labelTextWidth - 1);
          return (
            <Box key={metric.id} width={metricWidth} height={1} flexDirection="row" gap={1}>
              <Text fg={colors.textDim}>{truncate(metric.label, labelTextWidth)}</Text>
              <Text fg={metricColor(metric.tone)} attributes={TextAttributes.BOLD}>
                {truncate(metric.value, valueWidth)}
              </Text>
            </Box>
          );
        }) : detail ? (
          <Text fg={colors.textMuted}>
            {truncate(detail, detailWidth)}
          </Text>
        ) : null}
      </Box>
      {metrics.length === 0 && displayPreview.subtitle ? (
        <Text fg={colors.textMuted} wrapText width={contentWidth}>
          {displayPreview.subtitle}
        </Text>
      ) : null}
      {disclaimer ? (
        <Text fg={colors.textMuted} wrapText width={contentWidth}>
          {disclaimer}
        </Text>
      ) : null}
    </Box>
  );
}
