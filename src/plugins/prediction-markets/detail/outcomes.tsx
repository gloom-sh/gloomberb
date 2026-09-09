import { Box } from "../../../ui";
import { DataTableView, SectionHeading } from "../../../components";
import { colors } from "../../../theme/colors";
import {
  formatPredictionMetric,
  formatPredictionPercent,
  getPredictionProbabilityColor,
} from "../metrics";
import type { PredictionListRow } from "../types";
import { sortPredictionOutcomeMarkets } from "../outcome-order";

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
      <SectionHeading title="Outcomes" />

      <DataTableView
        columns={[
          { id: "target", label: "TARGET", width: labelWidth, align: "left" },
          { id: "odds", label: "ODDS", width: 7, align: "right" },
          { id: "volume", label: "24H VOL", width: 12, align: "right" },
        ]}
        items={sortedOutcomes}
        getItemKey={(market) => market.key}
        selection={{ kind: "id", selectedId: selectedMarketKey, getId: (market) => market.key, onChange: onSelectMarket }}
        sortColumnId={null}
        sortDirection="desc"
        onHeaderClick={() => {}}
        rootHeight={sortedOutcomes.length + 1}
        horizontalPadding={0}
        virtualize={false}
        emptyStateTitle="No outcomes"
        renderCell={(market, column) => {
          if (column.id === "target") return { text: market.marketLabel };
          if (column.id === "odds") return {
            text: formatPredictionPercent(market.yesPrice),
            color: getPredictionProbabilityColor(market.yesPrice) ?? colors.text,
          };
          return { text: formatPredictionMetric(market.volume24h, market.volume24hUnit), color: colors.textDim };
        }}
      />
    </Box>
  );
}
