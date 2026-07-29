import { Box, Text } from "../../../ui";
import { TextAttributes } from "../../../ui";
import { colors } from "../../../theme/colors";
import { padTo } from "../../../utils/format";
import {
  formatPredictionMetric,
  formatPredictionPercent,
  getPredictionProbabilityColor,
} from "../metrics";
import type { PredictionListRow } from "../types";
import { sortPredictionOutcomeMarkets } from "../outcome-order";

type OutcomePointerEvent = { preventDefault(): void };

export function PredictionMarketOutcomesView({
  detailWidth,
  onSelectMarket,
  selectedMarketKey,
  selectedRow,
}: {
  detailWidth: number;
  onSelectMarket: (marketKey: string) => void;
  selectedMarketKey: string;
  selectedRow: PredictionListRow;
}) {
  if (selectedRow.kind !== "group") return null;

  const sortedOutcomes = sortPredictionOutcomeMarkets(selectedRow.markets);
  const labelWidth = Math.max(detailWidth - 22, 12);

  return (
    <Box flexDirection="column">
      <Box height={1}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          Outcomes
        </Text>
      </Box>

      <Box flexDirection="row" height={1}>
        <Box width={labelWidth + 1}>
          <Text fg={colors.textDim}>{padTo("TARGET", labelWidth)}</Text>
        </Box>
        <Box width={8}>
          <Text fg={colors.textDim}>{padTo("ODDS", 7, "right")}</Text>
        </Box>
        <Box width={13}>
          <Text fg={colors.textDim}>{padTo("24H VOL", 12, "right")}</Text>
        </Box>
      </Box>

      {sortedOutcomes.map((market) => {
        const selected = market.key === selectedMarketKey;
        return (
          <Box
            key={market.key}
            flexDirection="row"
            height={1}
            backgroundColor={selected ? colors.selected : undefined}
            onMouseDown={(event: OutcomePointerEvent) => {
              event.preventDefault();
              onSelectMarket(market.key);
            }}
          >
            <Box width={labelWidth + 1}>
              <Text
                fg={selected ? colors.selectedText : colors.text}
                attributes={selected ? TextAttributes.BOLD : 0}
              >
                {padTo(market.marketLabel, labelWidth)}
              </Text>
            </Box>
            <Box width={8}>
              <Text
                fg={
                  selected
                    ? colors.selectedText
                    : getPredictionProbabilityColor(market.yesPrice) ??
                      colors.text
                }
              >
                {padTo(formatPredictionPercent(market.yesPrice), 7, "right")}
              </Text>
            </Box>
            <Box width={13}>
              <Text fg={selected ? colors.selectedText : colors.textDim}>
                {padTo(
                  formatPredictionMetric(
                    market.volume24h,
                    market.volume24hUnit,
                  ),
                  12,
                  "right",
                )}
              </Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}
