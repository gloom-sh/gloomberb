import { useCallback, useMemo, useState } from "react";
import type { ScannerHiloExtreme } from "../../../api-client";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  Tabs,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { usePaneSettingValue, usePaneStateValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { formatCompact } from "../../../utils/format";
import { usePluginTickerActions } from "../../runtime";
import { ScannerDeniedState } from "./denied";
import { useHiloFeed, useScannerStatusFooter } from "./feed";
import { HiloBars } from "./hilo-bars";
import { filterHiloRows, formatHiloPrice, type HiloMinPrice, type HiloSort } from "./hilo-model";

type Side = "lows" | "highs";

const SIDE_TABS: Array<{ label: string; value: Side }> = [
  { label: "Lows", value: "lows" },
  { label: "Highs", value: "highs" },
];

function rowKey(row: ScannerHiloExtreme, index: number): string {
  return `${row.symbol}:${row.at}:${index}`;
}

/** The 5 min, 1 min and 30 sec window rows. */
const BARS_HEIGHT = 3;
const QUERY_BAR_HEIGHT = 1;
/** Below this the two tables cannot both stay legible, so only the focused side is shown. */
const SPLIT_MIN_WIDTH = 42;
/** The bars are the lowest-priority panel: they go first when rows run out. */
const BARS_MIN_HEIGHT = QUERY_BAR_HEIGHT + BARS_HEIGHT + 4;
const MIN_PRICE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "1", label: "1" },
  { value: "5", label: "5" },
] as const satisfies ReadonlyArray<{ value: HiloMinPrice; label: string }>;
const SORT_OPTIONS = [
  { value: "recent", label: "Recent" },
  { value: "count", label: "Count" },
] as const satisfies ReadonlyArray<{ value: HiloSort; label: string }>;

function buildColumns(width: number, side: Side): DataTableColumn[] {
  // Wide enough for the "NEW HIGH" header that names the side.
  const symbolWidth = 10;
  const countWidth = 6;
  // Table chrome is one gap per column, two cells of padding, and the scrollbar.
  const priceWidth = Math.max(7, width - symbolWidth - countWidth - 3 - 2 - 1);
  return [
    { id: "symbol", label: side === "lows" ? "NEW LOW" : "NEW HIGH", width: symbolWidth, align: "left" },
    { id: "price", label: "PRICE", width: priceWidth, align: "right" },
    { id: "count", label: "COUNT", width: countWidth, align: "right" },
  ];
}

type RenderRow = (
  row: ScannerHiloExtreme,
  column: DataTableColumn,
  index: number,
  rowState: { selected: boolean },
) => DataTableCell;

// One adapter per side, created once, so the memoized table rows keep their
// identity while the feed ticks.
const RENDER_ROW: Record<Side, RenderRow> = {
  highs: (row, column, _index, rowState) => renderCell("highs", row, column, rowState),
  lows: (row, column, _index, rowState) => renderCell("lows", row, column, rowState),
};

function renderCell(
  side: Side,
  row: ScannerHiloExtreme,
  column: DataTableColumn,
  rowState: { selected: boolean },
): DataTableCell {
  const selectedColor = rowState.selected ? colors.selectedText : undefined;
  const sideColor = side === "lows" ? colors.negative : colors.positive;
  switch (column.id) {
    case "symbol":
      return {
        text: row.symbol,
        color: selectedColor ?? sideColor,
        attributes: TextAttributes.BOLD,
      };
    case "price":
      return {
        text: formatHiloPrice(row.price),
        color: selectedColor,
      };
    default:
      return {
        text: formatCompact(row.count),
        color: selectedColor ?? colors.textDim,
      };
  }
}

function HiloPane({ focused, width, height }: PaneProps) {
  const feed = useHiloFeed();
  const { pinTicker } = usePluginTickerActions();
  // The selection belongs to this pane; writing it into the portfolio moved and scrolled its cursor.
  const [, setCursorSymbol] = usePaneStateValue<string | null>("cursorSymbol", null);
  const [minPrice, setMinPrice] = usePaneSettingValue<HiloMinPrice>("minPrice", "1");
  const [sort, setSort] = usePaneSettingValue<HiloSort>("sort", "recent");
  const [activeSide, setActiveSide] = useState<Side>("lows");
  const [selected, setSelected] = useState<Record<Side, string | null>>({ lows: null, highs: null });

  const lows = useMemo(
    () => filterHiloRows(feed.payload?.lows, minPrice, sort),
    [feed.payload?.lows, minPrice, sort],
  );
  const highs = useMemo(
    () => filterHiloRows(feed.payload?.highs, minPrice, sort),
    [feed.payload?.highs, minPrice, sort],
  );

  useScannerStatusFooter("hilo", feed, focused);

  const split = width >= SPLIT_MIN_WIDTH;
  const showBars = height >= BARS_MIN_HEIGHT;
  // One cell of gutter keeps the two cursors from reading as a single wide row.
  const tableWidth = split ? Math.max(12, Math.floor((width - 1) / 2)) : Math.max(12, width);
  // A single table gets a strip naming its side, so the other side is visibly there.
  const sideStripRows = split ? 0 : 1;
  const tableHeight = Math.max(2, height - QUERY_BAR_HEIGHT - (showBars ? BARS_HEIGHT : 0) - sideStripRows);
  const columns = useMemo(() => ({ lows: buildColumns(tableWidth, "lows"), highs: buildColumns(tableWidth, "highs") }), [tableWidth]);

  const handleSelect = useCallback((side: Side, row: ScannerHiloExtreme, index: number) => {
    setActiveSide(side);
    setSelected((current) => ({ ...current, [side]: rowKey(row, index) }));
    setCursorSymbol(row.symbol);
  }, [setCursorSymbol]);

  const handleSideSwitchKey = useCallback((event: DataTableKeyEvent) => {
    if (event.name !== "left" && event.name !== "right") return false;
    event.preventDefault?.();
    event.stopPropagation?.();
    setActiveSide(event.name === "left" ? "lows" : "highs");
    return true;
  }, []);

  if (feed.denied) {
    return <ScannerDeniedState reason={feed.deniedReason} />;
  }

  const renderTable = (side: Side, rows: ScannerHiloExtreme[]) => (
    <DataTableView<ScannerHiloExtreme>
      focused={focused && activeSide === side}
      selection={{
        kind: "id",
        selectedId: selected[side],
        // The feed can report the same symbol more than once, so rows need a key
        // of their own instead of the ticker.
        getId: rowKey,
        onChange: (_id, row, index) => handleSelect(side, row, index),
      }}
      onRootKeyDown={handleSideSwitchKey}
      rootWidth={tableWidth}
      rootHeight={tableHeight}
      columns={columns[side]}
      items={rows}
      sortColumnId={null}
      sortDirection="desc"
      getItemKey={rowKey}
      onActivate={(row) => pinTicker(row.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID })}
      renderCell={RENDER_ROW[side]}
      emptyContent={feed.payload ? undefined : <PaneStatusBody loading loadingLabel="Waiting for the scanner..." />}
      emptyStateTitle="Nothing above the price filter yet."
    />
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <QueryBar
        width={width}
        filters={[
          { id: "min-price", label: "Min $", inline: true, value: minPrice, defaultValue: "1",
            options: MIN_PRICE_OPTIONS, onChange: setMinPrice },
          { id: "sort", label: "Sort", inline: true, value: sort, options: SORT_OPTIONS, onChange: setSort },
        ]}
      />
      {showBars && <HiloBars windows={feed.payload?.windows} width={width} />}
      {!split && (
        // Left and right (and h/l) switch sides, as they do between the split tables.
        <Box height={1} paddingX={1} flexShrink={0}>
          <Tabs
            tabs={SIDE_TABS}
            activeValue={activeSide}
            onSelect={(value) => setActiveSide(value as Side)}
            compact
            dense
            focused={focused}
          />
        </Box>
      )}
      <Box flexDirection="row" flexGrow={1} overflow="hidden">
        {split ? (
          <>
            {renderTable("lows", lows)}
            <Box width={1} flexShrink={0} />
            {renderTable("highs", highs)}
          </>
        ) : (
          // Too narrow for both: show the focused side and keep left/right switching it.
          renderTable(activeSide, activeSide === "lows" ? lows : highs)
        )}
      </Box>
    </Box>
  );
}

export default HiloPane;
