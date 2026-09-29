import { Box, Text, type ScrollBoxRenderable } from "../../../../ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import {
  DataTableView,
  DisclosureMarker,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { useAssetData } from "../../../runtime";
import { colors, priceColor } from "../../../../theme/colors";
import type { PricePoint } from "../../../../types/financials";
import { padTo } from "../../../../utils/format";
import { useBoundTicker, useTickerRequest } from "../../shared/ticker-request";
import type { FinancialTableStatement } from "./aggregation";
import { FINANCIAL_COL_W, FINANCIAL_LABEL_W } from "./model";
import { loadPeriodEndHistory } from "./period-end-history";
import {
  formatRatioInput,
  formatRatioValue,
  type RatioAmount,
  type RatioTableModel,
  type RatioTableRow,
} from "./ratios";

export type RatioTableColumn = DataTableColumn & (
  | { id: "metric"; kind: "metric" }
  | { id: string; kind: "statement"; statement: FinancialTableStatement; index: number }
);

const ratioRowKey = (row: RatioTableRow) => row.id;

export interface PeriodEndHistoryState {
  data: PricePoint[] | undefined;
  loading: boolean;
  error: string | null;
}

/**
 * Loads the daily closes behind period-end valuation and reports them up. It
 * mounts only while the Valuation tab is open, so the other tabs never ask for
 * history and the table itself needs no plugin runtime.
 */
export function PeriodEndHistoryLoader({ oldestPeriodEnd, onChange }: {
  oldestPeriodEnd: string;
  onChange: (state: PeriodEndHistoryState | null) => void;
}) {
  const provider = useAssetData();
  const { symbol, exchange } = useBoundTicker();
  const loader = useCallback((nextSymbol: string, nextExchange: string, forceRefresh: boolean): Promise<PricePoint[]> => {
    if (!provider) throw new Error("Market data unavailable");
    return loadPeriodEndHistory(provider, nextSymbol, nextExchange, oldestPeriodEnd, forceRefresh ? { cacheMode: "refresh" } : undefined);
  }, [oldestPeriodEnd, provider]);
  const { data, loading, error } = useTickerRequest(loader, symbol, exchange);
  useEffect(() => onChange({ data: data ?? undefined, loading, error: error ? String(error) : null }), [data, error, loading, onChange]);
  useEffect(() => () => onChange(null), [onChange]);
  return null;
}

function amountColor(amount: RatioAmount, color: string): string {
  return typeof amount === "number" ? color : colors.textMuted;
}

export function RatioTable({
  focused,
  model,
  columns,
  headerScrollRef,
  bodyScrollRef,
  syncHeaderScroll,
  headerScrollId,
  bodyScrollId,
  onToggle,
  exportMetadata,
  resetScrollKey,
  rootBefore,
}: {
  focused: boolean;
  model: RatioTableModel;
  columns: RatioTableColumn[];
  headerScrollRef: RefObject<ScrollBoxRenderable | null>;
  bodyScrollRef: RefObject<ScrollBoxRenderable | null>;
  syncHeaderScroll: () => void;
  headerScrollId?: string;
  bodyScrollId?: string;
  onToggle: (ratioId: string) => void;
  exportMetadata: () => string[][];
  resetScrollKey: string;
  rootBefore: ReactNode;
}) {
  const { rows, cells } = model;
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  useEffect(() => {
    if (rows.length === 0 || (selectedRowId && rows.some((row) => row.id === selectedRowId))) return;
    // A collapsed ratio keeps the cursor when it was on one of its inputs.
    const owner = selectedRowId ? rows.find((row) => row.kind === "ratio" && selectedRowId.startsWith(`${row.id}:`)) : undefined;
    setSelectedRowId((owner ?? rows[0]!).id);
  }, [rows, selectedRowId]);

  const renderCell = useCallback((row: RatioTableRow, column: RatioTableColumn): DataTableCell => {
    if (column.kind === "metric") {
      if (row.kind === "input") {
        return { text: `    ${row.unitLabel}`, color: colors.textDim };
      }
      return {
        text: `${row.expanded ? "▾" : "▸"} ${row.label}`,
        color: colors.text,
        // The desktop draws the disclosure as a path, not a glyph.
        content: (
          <Box flexDirection="row" alignItems="center" gap={1}>
            <DisclosureMarker expanded={row.expanded} color={colors.text} />
            <Text fg={colors.text}>{row.label}</Text>
          </Box>
        ),
        onMouseDown: (event) => {
          event.preventDefault?.();
          event.stopPropagation?.();
          onToggle(row.id);
        },
      };
    }
    const cell = cells.get(row.def.id)?.[column.index];
    if (!cell) return { text: "" };
    if (row.kind === "input") {
      const amount = cell.inputs[row.index]!;
      const input = row.def.inputs[row.index]!;
      return {
        text: padTo(formatRatioInput(input.format, amount, row.divisor), FINANCIAL_COL_W, "right"),
        color: amountColor(amount, colors.textDim),
      };
    }
    const tone = row.def.signed && typeof cell.value === "number" && cell.value !== 0 ? priceColor(cell.value) : colors.text;
    return {
      text: padTo(formatRatioValue(row.def.format, cell.value), FINANCIAL_COL_W, "right"),
      color: amountColor(cell.value, tone),
    };
  }, [cells, onToggle]);

  const selectedIndex = useMemo(() => rows.findIndex((row) => row.id === selectedRowId), [rows, selectedRowId]);

  return (
    <DataTableView<RatioTableRow, RatioTableColumn>
      focused={focused}
      headerScrollRef={headerScrollRef}
      scrollRef={bodyScrollRef}
      syncHeaderScroll={syncHeaderScroll}
      headerScrollId={headerScrollId}
      bodyScrollId={bodyScrollId}
      columns={columns}
      items={rows}
      selection={{
        kind: "id",
        selectedId: selectedIndex >= 0 ? selectedRowId : null,
        getId: (row) => row.id,
        onChange: (_id, row, _index, reason) => {
          setSelectedRowId(row.id);
          if (reason === "pointer" && row.kind === "ratio") onToggle(row.id);
        },
      }}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={ratioRowKey}
      onActivate={(row) => onToggle(row.kind === "ratio" ? row.id : row.def.id)}
      renderCell={renderCell}
      emptyStateTitle="No financial data"
      getExportMetadata={exportMetadata}
      showHorizontalScrollbar
      resetScrollKey={resetScrollKey}
      rootBefore={rootBefore}
    />
  );
}

export function ratioMetricColumn(): RatioTableColumn {
  return { id: "metric", kind: "metric", label: "Ratio", width: FINANCIAL_LABEL_W, align: "left" };
}
