import { useCallback, useMemo, useRef } from "react";
import type { GpuBoardRow } from "../../../api-client/gpu";
import { DataTableView, QueryBar, usePaneFooter, usePaneNoticeFooter, type DataTableColumn } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAssetData, useAsyncResource, useAutoRefresh, usePluginPaneState, usePluginTickerActions } from "../../../public/react";
import { priceColor } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { publicTickerKey } from "../../../utils/exchanges";
import { quoteBoardFooterInfo, quoteBoardStatus, renderQuoteBoardCell, useQuoteBoard } from "../shared/use-quote-board";
import { loadGpuEquityHistory } from "./client";
import { GPU_EQUITIES, gpuChange, gpuEquityRows, gpuLabel, gpuPrice, gpuSource } from "./model";

const SYMBOLS = GPU_EQUITIES.map(({ symbol }) => symbol);
const COLUMNS: DataTableColumn[] = [
  { id: "symbol", label: "Ticker", width: 7, align: "left" }, { id: "role", label: "Related through", width: 14, align: "left" },
  { id: "price", label: "Last $", width: 10, align: "right" }, { id: "changePercent", label: "1D", width: 8, align: "right" },
  { id: "five", label: "5D", width: 8, align: "right" }, { id: "gpu", label: "GPU", width: 16, align: "left" },
  { id: "gpuChange", label: "GPU 7D", width: 9, align: "right" }, { id: "source", label: "GPU list series", width: 23, flexGrow: 1, align: "left" },
];

export function GpuEquities({ board, model, setModel, reloadBoard, width, height, focused }: {
  board: GpuBoardRow[]; model: string; setModel: (value: string) => void; reloadBoard: () => void; width: number; height: number; focused: boolean;
}) {
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
  const historyMap = useMemo(() => new Map(history.data?.map((entry) => [entry.symbol, entry]) ?? []), [history.data]);
  const ends = [...new Set(history.data?.flatMap((entry) => entry.asOf ? [entry.asOf] : []) ?? [])].sort();
  usePaneFooter("gpu:equity-status", () => ({ info: [...quoteBoardFooterInfo(quoteBoardStatus(quotes)),
    ...(ends.length === 1 ? [{ id: "five-asof", parts: [{ text: `5D closes through ${ends[0]}`, tone: "muted" as const }] }] : [])] }), [quotes, ends.join(",")]);
  usePaneNoticeFooter({ registrationId: "gpu:equity-notices", focused,
    notices: [...(history.error ? [history.error] : []), ...(history.data?.flatMap((entry) => entry.error ? [entry.error] : []) ?? [])] });
  const dataRef = useRef({ quotes, historyMap });
  dataRef.current = { quotes, historyMap };
  const renderCell = useCallback((row: typeof rows[number], column: DataTableColumn) => {
    if (column.id === "symbol") return { text: row.symbol };
    if (column.id === "role") return { text: row.role };
    if (column.id === "gpu") return { text: row.reference ? gpuLabel(row.reference) : row.gpuModel };
    if (column.id === "source") return { text: row.reference ? gpuSource(row.reference) : "-" };
    if (column.id === "gpuChange") return { text: gpuChange(row.reference?.change7d), value: row.reference?.change7d ?? null };
    if (column.id === "five") {
      const value = dataRef.current.historyMap.get(row.symbol)?.value;
      return { text: gpuChange(value), value: value ?? null, color: value == null ? undefined : priceColor(value) };
    }
    return renderQuoteBoardCell(column.id as "price" | "changePercent", dataRef.current.quotes.get(row.symbol),
      { formatPrice: (quote) => gpuPrice(quote.price), formatChange: (quote) => gpuChange(quote.change) });
  }, []);
  const columns = width < 120 ? COLUMNS.map((column, index) => ({ ...column, width: [6, 8, 8, 6, 6, 13, 6, 12][index]!,
    label: column.id === "role" ? "Role" : column.id === "source" ? "List series" : column.label })) : COLUMNS;
  return <DataTableView columns={columns} items={rows} rootWidth={width} rootHeight={height} focused={focused}
    rootBefore={<QueryBar width={width} filters={[{ id: "gpu", label: "GPU", value: model || "H100",
      options: [...new Set(board.map((row) => row.gpuModel))].sort().map((value) => ({ value, label: value })), onChange: setModel }]} />}
    selection={{ kind: "id", selectedId: selected, getId: (row) => row.symbol, onChange: setSelected }} getItemKey={(row) => row.symbol}
    getRowVersion={(row) => [quotes.get(row.symbol)?.quote?.lastUpdated, quotes.get(row.symbol)?.loading, historyMap.get(row.symbol)?.value].join(":")}
    sortColumnId={null} sortDirection="asc" onActivate={(row) => pinTicker(publicTickerKey(row.symbol, row.exchange), { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null })}
    selectedTextOverridesCellColor renderCell={renderCell} emptyStateTitle="No related equities." />;
}
