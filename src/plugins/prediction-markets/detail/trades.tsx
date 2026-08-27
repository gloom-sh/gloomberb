import { useEffect, useState } from "react";
import { DataTableView, type DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatNumber } from "../../../utils/format";
import { formatPredictionProbability } from "../metrics";
import type { PredictionTrade } from "../types";

type TradeColumnId = "time" | "side" | "outcome" | "price" | "size";
type TradeColumn = DataTableColumn & { id: TradeColumnId };

const TRADE_COLUMNS: TradeColumn[] = [
  { id: "time", label: "TIME", width: 16, align: "left" },
  { id: "side", label: "SIDE", width: 6, align: "left" },
  { id: "outcome", label: "OUT", width: 4, align: "left" },
  { id: "price", label: "PRICE", width: 8, align: "right" },
  { id: "size", label: "SIZE", width: 10, align: "right" },
];

export function PredictionMarketTradesView({
  focused,
  trades,
  width,
}: {
  focused: boolean;
  trades: PredictionTrade[];
  width: number;
}) {
  const visibleTrades = trades.slice(0, 30);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(() =>
    visibleTrades.length > 0 ? 0 : null,
  );

  useEffect(() => {
    setSelectedIndex((current) => {
      if (visibleTrades.length === 0) return null;
      if (current == null || current >= visibleTrades.length) return 0;
      return current;
    });
  }, [visibleTrades.length]);

  return (
    <DataTableView<PredictionTrade, TradeColumn>
      focused={focused}
      keyboardNavigation={focused}
      rootWidth={width}
      rootBackgroundColor={colors.panel}
      selection={{
        kind: "index",
        selectedIndex,
        onChange: (index) => setSelectedIndex(index),
      }}
      columns={TRADE_COLUMNS}
      items={visibleTrades}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      getItemKey={(trade) => trade.id}
      onRowMouseDown={(_trade, index, event) => {
        event.preventDefault();
        setSelectedIndex(index);
        return true;
      }}
      renderCell={(trade, column, _index, rowState) => {
        const color = (fallback: string) =>
          rowState.selected ? undefined : fallback;
        const tradeColor = trade.side === "buy" ? colors.positive : colors.negative;
        switch (column.id) {
          case "time":
            return {
              text: new Date(trade.timestamp).toLocaleTimeString("en-US", {
                hour12: false,
              }),
              color: color(colors.textDim),
            };
          case "side":
            return {
              text: trade.side.toUpperCase(),
              color: color(tradeColor),
            };
          case "outcome":
            return {
              text: trade.outcome.toUpperCase(),
              color: color(colors.text),
            };
          case "price":
            return {
              text: formatPredictionProbability(trade.price),
              color: color(tradeColor),
            };
          case "size":
            return {
              text: formatNumber(trade.size, 0),
              color: color(colors.textDim),
            };
        }
      }}
      emptyStateTitle="No recent trades."
      emptyStateHint="This venue did not return recent prints."
    />
  );
}
