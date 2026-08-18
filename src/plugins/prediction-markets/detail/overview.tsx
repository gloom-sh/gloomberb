import { Box, Text } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { formatPercentRaw } from "../../../utils/format";
import type {
  PredictionListRow,
  PredictionMarketDetail,
  PredictionMarketSummary,
} from "../types";
import { PredictionMarketOutcomesView } from "./outcomes";
import { SummaryLink } from "./shared";

export function PredictionMarketOverviewView({
  detail,
  detailWidth,
  onSelectMarket,
  selectedRow,
  summary,
}: {
  detail: PredictionMarketDetail | null;
  detailWidth: number;
  onSelectMarket: (marketKey: string) => void;
  selectedRow: PredictionListRow | null;
  summary: PredictionMarketSummary;
}) {
  const textWidth = Math.max(detailWidth, 12);

  return (
    <Box flexDirection="column" gap={1}>
      {selectedRow?.kind === "group" && (
        <PredictionMarketOutcomesView
          detailWidth={detailWidth}
          onSelectMarket={onSelectMarket}
          selectedMarketKey={summary.key}
          selectedRow={selectedRow}
        />
      )}
      <SummaryLink
        url={summary.url}
        maxLength={Math.max(detailWidth - 8, 12)}
      />
      {summary.description && (
        <Box flexDirection="column" width={textWidth}>
          <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
            Description
          </Text>
          <Text fg={colors.text} width={textWidth} wrapMode="word" wrapText>
            {summary.description}
          </Text>
        </Box>
      )}
      <Box height={1}>
        <Text fg={colors.textDim}>
          {detail?.history &&
          detail.history.length > 1 &&
          summary.yesPrice != null
            ? `Range move ${formatPercentRaw((((detail.history[detail.history.length - 1]?.close ?? summary.yesPrice) - (detail.history[0]?.close ?? summary.yesPrice)) / Math.max(detail.history[0]?.close ?? summary.yesPrice, 0.0001)) * 100)}`
            : "No extended move data."}
        </Text>
      </Box>
    </Box>
  );
}
