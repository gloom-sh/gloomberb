import { useEffect, useMemo, useState } from "react";
import { DataTableView, type DataTableColumn } from "../../../components";
import { colors } from "../../../theme/colors";
import { formatNumber } from "../../../utils/format";
import { formatPredictionProbability } from "../metrics";
import type {
  PredictionBookLevel,
  PredictionMarketDetail,
} from "../types";

type BookColumnId = "outcome" | "side" | "price" | "size";
type BookColumn = DataTableColumn & { id: BookColumnId };

interface BookRow {
  id: string;
  outcome: "yes" | "no";
  side: "buy" | "sell";
  level: PredictionBookLevel;
}

const BOOK_COLUMNS: BookColumn[] = [
  { id: "outcome", label: "OUT", width: 5, align: "left" },
  { id: "side", label: "SIDE", width: 6, align: "left" },
  { id: "price", label: "PRICE", width: 8, align: "right" },
  { id: "size", label: "SIZE", width: 10, align: "right" },
];

function bookRowsForLevels({
  levels,
  outcome,
  side,
}: {
  levels: PredictionBookLevel[];
  outcome: "yes" | "no";
  side: "buy" | "sell";
}): BookRow[] {
  return levels.slice(0, 10).map((level, index) => ({
    id: `${outcome}:${side}:${index}:${level.price}:${level.size}`,
    outcome,
    side,
    level,
  }));
}

function buildBookRows(detail: PredictionMarketDetail): BookRow[] {
  return [
    ...bookRowsForLevels({
      levels: detail.book.yesBids,
      outcome: "yes",
      side: "buy",
    }),
    ...bookRowsForLevels({
      levels: detail.book.yesAsks,
      outcome: "yes",
      side: "sell",
    }),
    ...bookRowsForLevels({
      levels: detail.book.noBids,
      outcome: "no",
      side: "buy",
    }),
    ...bookRowsForLevels({
      levels: detail.book.noAsks,
      outcome: "no",
      side: "sell",
    }),
  ];
}

export function PredictionMarketBookView({
  detail,
  focused,
  width,
}: {
  detail: PredictionMarketDetail;
  focused: boolean;
  width: number;
}) {
  const rows = useMemo(() => buildBookRows(detail), [detail]);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(() =>
    rows.length > 0 ? 0 : null,
  );

  useEffect(() => {
    setSelectedIndex((current) => {
      if (rows.length === 0) return null;
      if (current == null || current >= rows.length) return 0;
      return current;
    });
  }, [rows.length]);

  return (
    <DataTableView<BookRow, BookColumn>
      focused={focused}
      keyboardNavigation={focused}
      rootWidth={width}
      rootBackgroundColor={colors.panel}
      selection={{
        kind: "index",
        selectedIndex,
        onChange: (index) => setSelectedIndex(index),
      }}
      columns={BOOK_COLUMNS}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      getItemKey={(row) => row.id}
      onRowMouseDown={(_row, index, event) => {
        event.preventDefault();
        setSelectedIndex(index);
        return true;
      }}
      renderCell={(row, column, _index, rowState) => {
        const color = (fallback: string) =>
          rowState.selected ? undefined : fallback;
        switch (column.id) {
          case "outcome":
            return {
              text: row.outcome.toUpperCase(),
              color: color(colors.textBright),
            };
          case "side":
            return {
              text: row.side === "buy" ? "BID" : "ASK",
              color: color(row.side === "buy" ? colors.positive : colors.negative),
            };
          case "price":
            return {
              text: formatPredictionProbability(row.level.price),
              color: color(colors.text),
            };
          case "size":
            return {
              text: formatNumber(row.level.size, 0),
              color: color(colors.textDim),
            };
        }
      }}
      emptyStateTitle={detail.book.error ? "Order book unavailable." : "No book levels."}
      emptyStateHint={detail.book.error ?? "This venue did not return current order book depth."}
    />
  );
}
