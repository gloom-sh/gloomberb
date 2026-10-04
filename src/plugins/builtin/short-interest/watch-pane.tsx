import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { loadingErrorFooterInfo, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneSettingValue, usePluginAppActions, usePluginPaneState, useTickers } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { formatShortDate } from "../../../utils/datetime-format";
import { formatCompact, formatNumber } from "../../../utils/format";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { loadShortWatch } from "./watch-client";
import {
  customUniverse,
  ownNamesUniverse,
  setupLabel,
  sharedDate,
  sortShortWatchRows,
  type ShortWatchRow,
  type ShortWatchSortId,
} from "./watch-model";

export const SHORT_WATCH_SCOPE_OPTIONS = [
  { value: "mine", label: "Portfolios and watchlists" },
  { value: "custom", label: "Custom symbols" },
] as const;
const SCOPE_FILTER_OPTIONS = SHORT_WATCH_SCOPE_OPTIONS.map((option) => ({
  ...option, short: option.value === "mine" ? "My names" : "Custom",
}));
const SYMBOLS_FIELD_WIDTH = 24;
/** Symbols apply once typing pauses, so a half-typed ticker does not start a load. */
const SYMBOLS_DEBOUNCE_MS = 700;

type WatchColumn = DataTableColumn & { id: ShortWatchSortId };
const COLUMNS: WatchColumn[] = [
  { id: "symbol", label: "Symbol", width: 8, align: "left" },
  { id: "setup", label: "Setup", width: 16, align: "left" },
  { id: "percentFloat", label: "% Float", width: 8, align: "right" },
  { id: "daysToCover", label: "Days", width: 6, align: "right" },
  { id: "changePercent", label: "SI Chg%", width: 8, align: "right" },
  { id: "return1M", label: "1M%", width: 8, align: "right" },
  { id: "sharesShort", label: "Short", width: 8, align: "right" },
  { id: "settlementDate", label: "Settled", width: 8, align: "right" },
  { id: "closeDate", label: "Close", width: 8, align: "right" },
];
const DEFAULT_SORT = { columnId: "setup" as ShortWatchSortId, direction: "desc" as SortDirection };
const rowKey = (row: ShortWatchRow) => row.symbol;

const day = (iso: string | null) => iso ? formatShortDate(`${iso}T00:00:00Z`, { year: false, utc: true, fallback: "--" }) : "--";
const signed = (value: number | null, digits = 1) => value == null ? "--" : `${value > 0 ? "+" : ""}${formatNumber(value, digits)}%`;
const signColor = (value: number | null) => value == null || value === 0 ? colors.textDim : value > 0 ? colors.positive : colors.negative;

export function ShortWatchPane({ width, height, focused }: Pick<PaneProps, "width" | "height" | "focused">) {
  const [scope, setScope] = usePaneSettingValue("scope", "mine");
  const [symbolsText, setSymbolsText] = usePaneSettingValue("symbols", "");
  const [symbolsActive, setSymbolsActive] = useState(false);
  const tickers = useTickers();
  const { createPaneFromTemplate } = usePluginAppActions();
  const custom = scope === "custom";
  const universe = useMemo(() => custom ? customUniverse(symbolsText) : ownNamesUniverse([...tickers.values()]),
    [custom, symbolsText, tickers]);
  const key = universe.symbols.join(",");
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    return loadShortWatch(key.split(","), { signal: current.signal, forceRefresh: force });
  }, [key]);
  useEffect(() => () => controller.current?.abort(), [loader]);
  const resource = useAsyncResource(key ? loader : null, { keepPreviousData: true });
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(resource.reload, { focused });

  const [sort, setSort] = usePluginPaneState<{ columnId: ShortWatchSortId; direction: SortDirection }>("short-watch:sort", DEFAULT_SORT);
  const rows = useMemo(() => sortShortWatchRows(resource.data ?? [], sort.columnId, sort.direction), [resource.data, sort]);
  // A date every row shares moves to the query bar; a column no row fills is left out.
  const settled = useMemo(() => sharedDate(rows, "settlementDate"), [rows]);
  const closed = useMemo(() => sharedDate(rows, "closeDate"), [rows]);
  const columns = useMemo(() => COLUMNS.filter((column) => !(column.id === "settlementDate" && settled)
    && !(column.id === "closeDate" && closed)
    && !(column.id === "percentFloat" && rows.length > 0 && rows.every((row) => row.percentFloat == null))), [rows, settled, closed]);
  const [selected, setSelected] = usePluginPaneState<string | null>("short-watch:selected", null);

  const unreported = rows.filter((row) => !row.settlementDate).map((row) => row.symbol);
  const unpriced = rows.filter((row) => row.settlementDate && row.return1M == null).map((row) => row.symbol);
  usePaneNoticeFooter({
    registrationId: "short-watch-notices",
    focused,
    notices: [
      universe.symbols.length ? universe.notice : null,
      resource.data ? resource.error : null,
      unreported.length ? `No short interest settlement for ${unreported.join(", ")}.` : null,
      unpriced.length ? `No month of daily closes for ${unpriced.join(", ")}.` : null,
    ].filter((value): value is string => !!value),
  });
  usePaneFooter("short-watch", () => ({
    info: [
      ...loadingErrorFooterInfo(resource.loading && !!resource.data, null),
    ],
  }), [resource.loading, resource.data]);
  // Dates every row shares are the table's as-of context.
  const asOf = [settled ? `settled ${day(settled)}` : null, closed ? `closes to ${day(closed)}` : null]
    .filter(Boolean).join(" · ") || undefined;

  const renderCell = useCallback((row: ShortWatchRow, column: WatchColumn): DataTableCell => {
    switch (column.id) {
      case "symbol": return { text: row.symbol, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "setup": return { text: setupLabel(row.setup), color: row.setup === "crowded-rising" ? colors.warning : colors.textDim };
      case "percentFloat": return { text: row.percentFloat == null ? "--" : `${formatNumber(row.percentFloat, 1)}%`,
        color: row.setup ? colors.textBright : colors.text, value: row.percentFloat ?? undefined };
      case "daysToCover": return { text: row.daysToCover == null ? "--" : formatNumber(row.daysToCover, 1), value: row.daysToCover ?? undefined };
      case "changePercent": return { text: signed(row.changePercent), value: row.changePercent ?? undefined };
      case "return1M": return { text: signed(row.return1M), color: signColor(row.return1M), value: row.return1M ?? undefined };
      case "sharesShort": return { text: row.sharesShort == null ? "--" : formatCompact(row.sharesShort), color: colors.textDim,
        value: row.sharesShort ?? undefined };
      case "settlementDate": return { text: day(row.settlementDate), color: colors.textDim, value: row.settlementDate ?? undefined };
      case "closeDate": return { text: day(row.closeDate), color: colors.textDim, value: row.closeDate ?? undefined };
    }
  }, []);

  const emptyTitle = custom ? "Add symbols to watch." : "No US-listed names in your portfolios or watchlists.";
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} meta={asOf} filters={[
      { id: "scope", label: "Names", value: custom ? "custom" : "mine", options: SCOPE_FILTER_OPTIONS, onChange: setScope },
      ...(custom ? [{ id: "symbols", kind: "text" as const, label: "Symbols", value: symbolsText, placeholder: "GME, AMC, CVNA",
        width: SYMBOLS_FIELD_WIDTH, debounceMs: SYMBOLS_DEBOUNCE_MS, focused, active: symbolsActive, onActiveChange: setSymbolsActive,
        onChange: setSymbolsText }] : []),
    ]} />
    <PaneStatusBody
      subject="short interest"
      loading={!!key && !resource.data && resource.loading}
      error={!resource.data ? resource.error : null}
      empty={!key}
      emptyTitle={emptyTitle}
      emptyMessage={universe.notice ?? undefined}
    >
      <DataTableView<ShortWatchRow, WatchColumn>
        focused={focused && !symbolsActive}
        columns={columns}
        items={rows}
        rootWidth={width}
        rootHeight={Math.max(2, height - 1)}
        freezeFirstColumn
        getItemKey={rowKey}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id as ShortWatchSortId, { firstDirection: "desc" }))}
        selection={{ kind: "id", selectedId: rows.some((row) => row.symbol === selected) ? selected! : rows[0]?.symbol ?? "",
          getId: rowKey, onChange: (id) => setSelected(id) }}
        onActivate={(row) => createPaneFromTemplate("short-interest-pane", { symbol: row.symbol })}
        getExportMetadata={() => [["settled", settled ?? undefined], ["closes to", closed ?? undefined],
          ["% float", "latest settlement's shares short over the current float"], ["1M", "close-to-close over one calendar month"]]}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        emptyStateTitle="No names"
      />
    </PaneStatusBody>
  </Box>;
}
