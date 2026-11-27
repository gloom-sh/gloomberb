import { formatDay } from "../../../../utils/day-format";
import { Box, Text, useUiCapabilities, type ScrollBoxRenderable } from "../../../../ui";
import { useCallback, useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import {
  DataTableView,
  DisclosureMarker,
  ExternalLinkText,
  type DataTableCell,
  type DataTableColumn,
} from "../../../../components";
import { useAssetData } from "../../../runtime";
import { colors, priceColor } from "../../../../theme/colors";
import { notMeaningfulColor } from "../../../../components/ui/not-meaningful";
import type { PricePoint } from "../../../../types/financials";
import type { FxCloses } from "../../../../market-data/fx-closes";
import { apiClient } from "../../../../api-client";
import { loadValuationFx } from "../../../../time-series/valuation-currency";
import { PERIOD_END_ROW_ID } from "../../../../utils/financial-statements";
import { displayWidth, padTo } from "../../../../utils/format";
import { useBoundTicker, useTickerRequest } from "../../shared/ticker-request";
import type { FinancialTableStatement } from "./aggregation";
import { FINANCIAL_COL_W, financialLabelWidth, financialPeriodHeaderLabel } from "./model";
import { loadPeriodEndHistory } from "./period-end-history";
import {
  formatRatioInput,
  formatRatioValue,
  ratioPeriodEnd,
  type RatioAmount,
  type RatioTableModel,
  type RatioTableRow,
} from "./ratios";

export type RatioTableColumn = DataTableColumn & (
  | { id: "metric"; kind: "metric" }
  | { id: string; kind: "statement"; statement: FinancialTableStatement; index: number }
);

/**
 * The first row of a statement or ratio table: the day each column's period
 * ends, under the fiscal period that heads it (`FY2026` over `2026-01-25`).
 * It is part of the heading, so the cursor passes it.
 */
export interface PeriodEndRow {
  kind: "period-end";
  id: typeof PERIOD_END_ROW_ID;
}
export const PERIOD_END_ROW: PeriodEndRow = { kind: "period-end", id: PERIOD_END_ROW_ID };

/** The period-end row's name, in the metric column: under the column's own header, as its second line. */
export const PERIOD_END_NAME_CELL: DataTableCell = { text: "Period end", color: colors.textMuted };

/**
 * A statement's period-end cell: the day, centred in the cells the header
 * over it is centred in. The table draws a header against its column's right
 * edge on the desktop and the web and in the last column (`flush`), and a
 * cell short of it elsewhere, so the day is drawn the same way.
 */
export function periodEndCell(end: string | undefined, width: number, flush: boolean, filingUrl?: string): DataTableCell {
  if (!end) return { text: "" };
  const shown = formatDay(end);
  const day = financialPeriodHeaderLabel(shown, width);
  const padded = flush ? day : `${day} `;
  const start = day.indexOf(shown);
  return {
    // A day, not a figure: written day first, exported as its ISO date.
    text: shown,
    value: end,
    color: colors.textMuted,
    content: (
      <Box flexDirection="row" width={width} justifyContent="flex-end">
        {filingUrl ? <>
          <Text>{padded.slice(0, start)}</Text>
          <ExternalLinkText url={filingUrl} label={shown} />
          <Text>{padded.slice(start + shown.length)}</Text>
        </> : <Text fg={colors.textMuted}>{padded}</Text>}
      </Box>
    ),
  };
}

type RatioTableViewRow = RatioTableRow | PeriodEndRow;

const ratioRowKey = (row: RatioTableViewRow) => row.id;
const isRatioLine = (row: RatioTableViewRow) => row.kind !== "period-end";

/**
 * A ratio's name in the metric column, after its disclosure, a cell apart: as wide as it says
 * (`contentWidth`), so the table fits the column to it whole. The desktop draws the disclosure as a
 * path, not a glyph.
 */
export function ratioNameCell(
  row: Extract<RatioTableRow, { kind: "ratio" }>,
  color: string,
): Pick<DataTableCell, "text" | "contentWidth" | "content"> {
  const text = `${row.expanded ? "▾" : "▸"} ${row.label}`;
  return {
    text,
    contentWidth: displayWidth(text),
    content: (
      <Box flexDirection="row" alignItems="center" gap={1}>
        <DisclosureMarker expanded={row.expanded} color={color} />
        <Text fg={color}>{row.label}</Text>
      </Box>
    ),
  };
}

export interface PeriodEndHistoryState {
  data: PricePoint[] | undefined;
  fx?: ReadonlyMap<string, FxCloses>;
  loading: boolean;
  error: string | null;
}

/**
 * Loads the daily closes behind period-end valuation and reports them up. It
 * mounts only while the Valuation tab is open, so the other tabs never ask for
 * history and the table itself needs no plugin runtime.
 */
export function PeriodEndHistoryLoader({ oldestPeriodEnd, fxCurrencies, onChange }: {
  oldestPeriodEnd: string;
  fxCurrencies: string;
  onChange: (state: PeriodEndHistoryState | null) => void;
}) {
  const provider = useAssetData();
  const { symbol, exchange } = useBoundTicker();
  const loader = useCallback(async (nextSymbol: string, nextExchange: string, forceRefresh: boolean) => {
    if (!provider) throw new Error("Market data unavailable");
    const [prices, fx] = await Promise.all([
      loadPeriodEndHistory(provider, nextSymbol, nextExchange, oldestPeriodEnd, forceRefresh ? { cacheMode: "refresh" } : undefined),
      loadValuationFx(fxCurrencies ? fxCurrencies.split(",") : [], oldestPeriodEnd, apiClient),
    ]);
    return { prices, fx };
  }, [oldestPeriodEnd, provider, fxCurrencies]);
  const { data, loading, error } = useTickerRequest(loader, symbol, exchange, ["period-end-history", oldestPeriodEnd, fxCurrencies]);
  useEffect(() => onChange({ data: data?.prices, fx: data?.fx, loading, error: error ? String(error) : null }), [data, error, loading, onChange]);
  useEffect(() => () => onChange(null), [onChange]);
  return null;
}

/** A figure in its colour; N/M as every pane draws it; any other gap muted. */
function amountColor(amount: RatioAmount, color: string): string {
  return typeof amount === "number" ? color : amount === "not-meaningful" ? notMeaningfulColor() : colors.textMuted;
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
  const { nativePaneChrome } = useUiCapabilities();
  const [selectedRowId, setSelectedRowId] = useState<string | null>(null);
  useEffect(() => {
    if (rows.length === 0 || (selectedRowId && rows.some((row) => row.id === selectedRowId))) return;
    // A collapsed ratio keeps the cursor when it was on one of its inputs.
    const owner = selectedRowId ? rows.find((row) => row.kind === "ratio" && selectedRowId.startsWith(`${row.id}:`)) : undefined;
    setSelectedRowId((owner ?? rows[0]!).id);
  }, [rows, selectedRowId]);

  const renderCell = useCallback((row: RatioTableViewRow, column: RatioTableColumn): DataTableCell => {
    if (row.kind === "period-end") {
      if (column.kind === "metric") return PERIOD_END_NAME_CELL;
      return periodEndCell(ratioPeriodEnd(column.statement), column.width, nativePaneChrome || column === columns[columns.length - 1]);
    }
    if (column.kind === "metric") {
      if (row.kind === "input") {
        return { text: `    ${row.unitLabel}`, color: colors.textDim };
      }
      return {
        ...ratioNameCell(row, colors.text),
        color: colors.text,
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
        text: padTo(formatRatioInput(input.format, amount, row.divisor, row.def.format), FINANCIAL_COL_W, "right"),
        color: amountColor(amount, colors.textDim),
      };
    }
    const tone = row.def.signed && typeof cell.value === "number" && cell.value !== 0 ? priceColor(cell.value) : colors.text;
    return {
      text: padTo(formatRatioValue(row.def.format, cell.value), FINANCIAL_COL_W, "right"),
      color: amountColor(cell.value, tone),
    };
  }, [cells, columns, nativePaneChrome, onToggle]);

  const selectedIndex = useMemo(() => rows.findIndex((row) => row.id === selectedRowId), [rows, selectedRowId]);
  const tableRows = useMemo<RatioTableViewRow[]>(() => rows.length ? [PERIOD_END_ROW, ...rows] : rows, [rows]);

  return (
    <DataTableView<RatioTableViewRow, RatioTableColumn>
      focused={focused}
      headerScrollRef={headerScrollRef}
      scrollRef={bodyScrollRef}
      syncHeaderScroll={syncHeaderScroll}
      headerScrollId={headerScrollId}
      bodyScrollId={bodyScrollId}
      columns={columns}
      // The statements' fiscal periods: an axis, not columns to arrange.
      columnReorder={false}
      items={tableRows}
      // The cursor walks the ratios; the period ends are part of the heading.
      isNavigable={isRatioLine}
      selection={{
        kind: "id",
        selectedId: selectedIndex >= 0 ? selectedRowId : null,
        getId: (row) => row.id,
        onChange: (_id, row, _index, reason) => {
          if (row.kind === "period-end") return;
          setSelectedRowId(row.id);
          if (reason === "pointer" && row.kind === "ratio") onToggle(row.id);
        },
      }}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={ratioRowKey}
      onActivate={(row) => {
        if (row.kind !== "period-end") onToggle(row.kind === "ratio" ? row.id : row.def.id);
      }}
      renderCell={renderCell}
      emptyStateTitle="No financial data"
      getExportMetadata={exportMetadata}
      showHorizontalScrollbar
      resetScrollKey={resetScrollKey}
      rootBefore={rootBefore}
    />
  );
}

export function ratioMetricColumn(width: number): RatioTableColumn {
  return { id: "metric", kind: "metric", label: "Ratio", width: financialLabelWidth(width), align: "left" };
}
