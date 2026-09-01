import { Button } from "../../../components/ui/button";
import { Box, Text } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { formatCurrency } from "../../../utils/format";
import type { TradeTicketState } from "../trading/state";
import {
  formatPreviewMetric,
  formatPreviewSummary,
  getTradeTonePalette,
  truncateTradeText as truncateText,
  type TradeTone,
} from "./utils";

function TradePreviewMetric({
  label,
  value,
  tone = "neutral",
  width,
}: {
  label: string;
  value: string;
  tone?: TradeTone;
  width: number;
}) {
  return (
    <Box
      key={label}
      width={width}
      height={1}
      backgroundColor={colors.panel}
      paddingX={1}
      marginRight={1}
    >
      <Text fg={tone === "negative" ? colors.negative : tone === "positive" ? colors.positive : colors.text}>
        {truncateText(`${label} ${value}`, Math.max(6, width - 2))}
      </Text>
    </Box>
  );
}

export function TradePreviewPanel({
  previewPanelWidth,
  previewTextWidth,
  previewMetricWidth,
  previewTone,
  previewHeading,
  ticketState,
  onPreviewOrder,
  onSubmitOrder,
}: {
  previewPanelWidth?: number;
  previewTextWidth: number;
  previewMetricWidth: number;
  previewTone: TradeTone;
  previewHeading: string;
  ticketState: TradeTicketState;
  onPreviewOrder: () => void;
  onSubmitOrder: () => void;
}) {
  return (
    <Box
      flexDirection="column"
      width={previewPanelWidth}
      minWidth={34}
      border
      borderStyle="rounded"
      borderColor={getTradeTonePalette(previewTone).border}
      paddingX={1}
    >
      <Box height={1} flexDirection="row">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>Preview</Text>
        <Box flexGrow={1} />
        <Text fg={getTradeTonePalette(previewTone).text}>{previewHeading}</Text>
      </Box>
      <Text fg={ticketState.preview?.warningText ? colors.negative : colors.textMuted}>
        {truncateText(formatPreviewSummary(ticketState.preview), previewTextWidth)}
      </Text>

      <Box flexDirection="row" flexWrap="wrap">
        <TradePreviewMetric
          label="Fee"
          value={ticketState.preview?.commission != null
            ? formatCurrency(ticketState.preview.commission, ticketState.preview.commissionCurrency || "USD")
            : "—"}
          width={previewMetricWidth}
        />
        <TradePreviewMetric
          label="Init"
          value={formatPreviewMetric(ticketState.preview?.initMarginBefore, ticketState.preview?.initMarginAfter)}
          width={previewMetricWidth}
        />
        <TradePreviewMetric
          label="Maint"
          value={formatPreviewMetric(ticketState.preview?.maintMarginBefore, ticketState.preview?.maintMarginAfter)}
          width={previewMetricWidth}
        />
        <TradePreviewMetric
          label="Equity"
          value={formatPreviewMetric(ticketState.preview?.equityWithLoanBefore, ticketState.preview?.equityWithLoanAfter)}
          width={previewMetricWidth}
        />
        {ticketState.preview?.warningText && (
          <TradePreviewMetric
            label="Warn"
            value={ticketState.preview.warningText}
            tone="negative"
            width={previewMetricWidth}
          />
        )}
      </Box>

      <Box flexDirection="row" flexWrap="wrap">
        <Button
          label="Preview"
          variant="secondary"
          disabled={ticketState.busy}
          onPress={onPreviewOrder}
        />
        <Box width={1} />
        <Button
          label={ticketState.editingOrderId ? "Submit Change" : "Submit Order"}
          variant="primary"
          disabled={!ticketState.preview || ticketState.busy}
          onPress={onSubmitOrder}
        />
      </Box>
    </Box>
  );
}
