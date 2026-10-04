import { useCallback, useMemo, useRef } from "react";
import type { GpuBoardRow } from "../../../api-client/gpu";
import {
  buildSectionedRows, DataTableView, EMPTY_TABLE_CELL, isSectionedItemRow, renderSectionedRowHeader, usePaneFooter, usePaneNoticeFooter,
  type DataTableCell, type DataTableColumn, type SectionedRow,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { PriceSparkline } from "../../../components/price-sparkline/view";
import { useAssetData, useAsyncResource, useAutoRefresh, usePluginPaneState, usePluginTickerActions } from "../../../public/react";
import { priceColor } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { Box, Text, TextAttributes } from "../../../ui";
import { publicTickerKey } from "../../../utils/exchanges";
import { displayWidth, truncateToDisplayWidth } from "../../../utils/format";
import { quoteBoardFooterInfo, quoteBoardStatus, renderQuoteBoardCell, useQuoteBoard } from "../shared/use-quote-board";
import { GpuModelQuery } from "./board";
import { loadGpuEquityHistory } from "./client";
import { GPU_EQUITIES, GPU_EQUITY_GROUPS, gpuChange, gpuChangeColor, gpuEquityRows, gpuPrice, gpuShortSource, gpuVariant } from "./model";

const SYMBOLS = GPU_EQUITIES.map(({ symbol }) => symbol);
type EquityRow = ReturnType<typeof gpuEquityRows>[number];
type Row = SectionedRow<EquityRow>;
const rowKey = (row: Row) => row.key;

function equityColumns(width: number): DataTableColumn[] {
  const wide = width >= 140, medium = width >= 100;
  return [
    { id: "symbol", label: "Ticker", width: 7, align: "left" },
    { id: "price", label: "Last $", width: medium ? 10 : 8, align: "right" },
    { id: "changePercent", label: "1D", width: 8, align: "right" },
    { id: "five", label: "5D", width: 8, align: "right" },
    ...(medium ? [{ id: "trend", label: "1M", width: wide ? 16 : 10, align: "left" as const }] : []),
    // The GPU move sits next to the share's moves; the series that sets it reads last.
    { id: "gpuChange", label: "GPU 7D", width: medium ? 8 : 7, align: "right" },
    { id: "gpuPrice", label: medium ? "$/GPU-hr" : "$/h", width: medium ? 9 : 6, align: "right" },
    { id: "source", label: "GPU list series", width: wide ? 34 : medium ? 26 : 14, flexGrow: 1, align: "left" },
  ];
}

/** Related shares by what ties them to GPU rents, each beside the list price that ties it. */
export function GpuEquities({ board, model, setModel, reloadBoard, width, height, focused }: {
  board: GpuBoardRow[]; model: string; setModel: (value: string) => void; reloadBoard: () => void; width: number; height: number; focused: boolean;
}) {
  const colors = useThemeColors();
  const provider = useAssetData();
  const { pinTicker } = usePluginTickerActions();
  const [selected, setSelected] = usePluginPaneState<string | null>("equitySelected", "NVDA");
  const { quotes, refresh } = useQuoteBoard(SYMBOLS, { liveStreaming: false, selectedSymbol: selected });
  const loader = useCallback(async () => {
    if (!provider) throw new Error("Equity history is not available.");
    return loadGpuEquityHistory(provider);
  }, [provider]);
  const history = useAsyncResource(loader);
  useAutoRefresh(history.updatedAt, history.load);
  usePaneRefreshKey(() => { reloadBoard(); refresh(); void history.reload(); }, { focused });
  const rows = useMemo(() => gpuEquityRows(board, model || "H100"), [board, model]);
  const items = useMemo(() => buildSectionedRows(GPU_EQUITY_GROUPS.map((group) => ({ label: group.label,
    items: rows.filter((row) => (group.roles as readonly string[]).includes(row.role)) })), (row) => row.symbol), [rows]);
  const historyMap = useMemo(() => new Map(history.data?.map((entry) => [entry.symbol, entry]) ?? []), [history.data]);
  const ends = [...new Set(history.data?.flatMap((entry) => entry.asOf ? [entry.asOf] : []) ?? [])].sort();
  usePaneFooter("gpu:equity-status", () => ({ info: [...quoteBoardFooterInfo(quoteBoardStatus(quotes)),
    ...(ends.length === 1 ? [{ id: "five-asof", parts: [{ text: `5D closes through ${ends[0]}`, tone: "muted" as const }] }] : [])] }), [quotes, ends.join(",")]);
  usePaneNoticeFooter({ registrationId: "gpu:equity-notices", focused,
    notices: [...(history.error ? [history.error] : []), ...(history.data?.flatMap((entry) => entry.error ? [entry.error] : []) ?? [])] });
  const dataRef = useRef({ quotes, historyMap });
  dataRef.current = { quotes, historyMap };
  const medium = width >= 100;
  const renderCell = useCallback((item: Row, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(item)) return EMPTY_TABLE_CELL;
    const row = item.item;
    const reference = row.reference;
    switch (column.id) {
      case "symbol": return { text: row.symbol, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "source": {
        if (!reference) return { text: "", color: colors.textDim };
        const name = gpuShortSource(reference);
        const variant = [row.gpuModel, ...gpuVariant(reference)].join(" ");
        // The name keeps its room; the variant gives way first.
        const rest = Math.max(0, column.width - displayWidth(name) - 2);
        return { text: `${name} ${variant}`, content: <Box flexDirection="row" height={1} overflow="hidden">
          <Text fg={state.selected ? colors.selectedText : colors.text}>{truncateToDisplayWidth(name, column.width)}</Text>
          {rest >= 4 ? <Text fg={state.selected ? colors.selectedText : colors.textDim}>{`  ${truncateToDisplayWidth(variant, rest)}`}</Text> : null}
        </Box> };
      }
      case "gpuPrice": return reference ? { text: gpuPrice(reference.pricePerGpuHr), value: reference.pricePerGpuHr, color: colors.textBright } : { text: "" };
      case "gpuChange": {
        if (!reference) return { text: "" };
        const value = reference.change7d;
        return value == null ? { text: "new", value: null, color: colors.textMuted } : { text: gpuChange(value), value, color: gpuChangeColor(value, colors) };
      }
      case "five": {
        const value = dataRef.current.historyMap.get(row.symbol)?.value;
        return { text: value == null ? "" : gpuChange(value), value: value ?? null, color: value == null ? undefined : priceColor(value) };
      }
      case "trend": {
        const points = dataRef.current.historyMap.get(row.symbol)?.history;
        return points && points.length > 2 ? { text: "", content: <PriceSparkline priceHistory={points} width={column.width} period="1M" /> } : { text: "" };
      }
      default: return renderQuoteBoardCell(column.id as "price" | "changePercent", dataRef.current.quotes.get(row.symbol),
        { formatPrice: (quote) => gpuPrice(quote.price), formatChange: (quote) => gpuChange(quote.change) });
    }
  }, [colors]);
  return <DataTableView<Row> columns={equityColumns(width)} items={items} rootWidth={width} rootHeight={height} focused={focused}
    rootBefore={<GpuModelQuery rows={board} model={model || "H100"} setModel={setModel} width={width} allowAll={false} />}
    selection={{ kind: "id", selectedId: selected, getId: rowKey, onChange: (id) => setSelected(String(id)) }} getItemKey={rowKey}
    isNavigable={isSectionedItemRow} renderSectionHeader={renderSectionedRowHeader}
    getRowVersion={(row) => isSectionedItemRow(row) ? [quotes.get(row.item.symbol)?.quote?.lastUpdated, quotes.get(row.item.symbol)?.loading,
      historyMap.get(row.item.symbol)?.value, medium].join(":") : row.key}
    sortColumnId={null} sortDirection="asc" onActivate={(row) => { if (isSectionedItemRow(row)) pinTicker(publicTickerKey(row.item.symbol, row.item.exchange), { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null }); }}
    selectedTextOverridesCellColor renderCell={renderCell} emptyStateTitle="No related equities." />;
}
