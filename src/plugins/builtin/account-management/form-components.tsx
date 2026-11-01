import { type ReactNode, type Ref } from "react";
import {
  Button,
  Checkbox,
  FieldLabel,
  MultiSelectDialogButton,
  SelectButton,
  type ChoiceDialogChoice,
  type MultiSelectDialogButtonHandle,
} from "../../../components";
import { chatDeskChoices } from "../chat/people";
import { Box, Text, TextAttributes, type BoxRenderable } from "../../../ui";
import { colors } from "../../../theme/colors";
import { truncateWithEllipsis } from "../../../utils/text-wrap";
import type { SelectControl } from "../../../components/ui/select-button";
import type { ProfileAnalyticsPreview } from "./model";
import { t } from "../../../i18n";
import { ClippedText } from "../../../components/ui/display";

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
  nodeRef,
  onFocus,
  onChange,
}: {
  label: string;
  checked: boolean;
  active: boolean;
  description?: string;
  width: number;
  nodeRef?: Ref<BoxRenderable>;
  onFocus: () => void;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Box ref={nodeRef}>
      <Checkbox label={label} checked={checked} active={active} description={description} width={width} onChange={(next) => { onFocus(); onChange(next); }} />
    </Box>
  );
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
  nodeRef,
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
  nodeRef?: Ref<BoxRenderable>;
  onFocus: () => void;
  onSelect: (value: string) => void;
}) {
  const contentWidth = Math.max(1, width - 2);
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
      ref={nodeRef}
      flexDirection="column"
      width={width}
      onMouseOver={onFocus}
    >
      <Box height={1} flexDirection="row" gap={1} alignItems="center">
        <FieldLabel label={t("Public Stats:")} active={active} maxWidth={labelWidth} />
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
              <ClippedText fg={colors.textDim} text={metric.label} width={labelTextWidth} cut={truncateWithEllipsis} />
              <ClippedText fg={metricColor(metric.tone)} attributes={TextAttributes.BOLD} text={metric.value} width={valueWidth} cut={truncateWithEllipsis} />
            </Box>
          );
        }) : detail ? (
          <ClippedText fg={colors.textMuted} text={detail} width={detailWidth} cut={truncateWithEllipsis} />
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

/**
 * The desks chat shows beside your name, once What I Trade is on: pre-filled
 * from your answer to "What do you trade most?", coarse words only.
 */
export function DeskChoiceRow({
  desks,
  active,
  width,
  controlRef,
  nodeRef,
  onFocus,
  onChange,
}: {
  desks: string[];
  active: boolean;
  width: number;
  controlRef?: Ref<MultiSelectDialogButtonHandle>;
  nodeRef?: Ref<BoxRenderable>;
  onFocus: () => void;
  onChange: (desks: string[]) => void;
}) {
  const labelWidth = Math.min(accountFieldLabelWidth(width), Math.max(1, width - 2));
  return (
    <Box ref={nodeRef} height={1} flexDirection="row" gap={1} alignItems="center" width={width} onMouseOver={onFocus}>
      <FieldLabel label={t("Trades")} active={active} maxWidth={labelWidth} />
      <MultiSelectDialogButton
        ref={controlRef}
        label={t("Trades")}
        title={t("What I Trade")}
        options={chatDeskChoices().map((choice) => ({ value: choice.value, label: t(choice.label) }))}
        selectedValues={desks}
        emptyLabel={t("None")}
        onOpenChange={(open) => { if (open) onFocus(); }}
        onChange={onChange}
        // The label beside it already says Trades: the button shows the picks.
        renderTrigger={({ summary, disabled, openDialog }) => (
          <Button label={summary} variant="secondary" active={active} disabled={disabled} onPress={() => openDialog()} />
        )}
      />
    </Box>
  );
}
