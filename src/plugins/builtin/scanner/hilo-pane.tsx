import { useCallback, useMemo, useState } from "react";
import { Box, TextAttributes } from "../../../ui";
import {
  DataTableView,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import { formatCompact, formatNumber } from "../../../utils/format";
import type { PaneProps } from "../../../types/plugin";
import type { ScannerHiloExtreme } from "../../../api-client";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import { usePluginPaneActions, usePluginTickerActions } from "../../runtime";
import { ScannerDeniedState } from "./denied";
import { useHiloFeed, useScannerStatusFooter } from "./feed";
import { HiloBars } from "./hilo-bars";
import { filterHiloRows, type HiloMinPrice, type HiloSort } from "./hilo-model";

type Side = "lows" | "highs";

function rowKey(row: ScannerHiloExtreme, index: number): string {
  return `${row.symbol}:${row.at}:${index}`;
}

const BARS_HEIGHT = 4;

function buildColumns(width: number): DataTableColumn[] {
  const symbolWidth = 8;
  const countWidth = 6;
  // Table chrome is one gap per column, two cells of padding, and the scrollbar.
  const priceWidth = Math.max(7, width - symbolWidth - countWidth - 3 - 2 - 1);
  return [
    { id: "symbol", label: "SYMBOL", width: symbolWidth, align: "left" },
    { id: "price", label: "PRICE", width: priceWidth, align: "right" },
    { id: "count", label: "COUNT", width: countWidth, align: "right" },
  ];
}

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
        text: row.price >= 1000 ? formatNumber(row.price, 2) : row.price.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""),
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
  const { selectTicker } = usePluginPaneActions();
  const { pinTicker } = usePluginTickerActions();
  const [minPrice] = usePaneSettingValue<HiloMinPrice>("minPrice", "1");
  const [sort] = usePaneSettingValue<HiloSort>("sort", "recent");
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

  // One cell of gutter keeps the two cursors from reading as a single wide row.
  const tableWidth = Math.max(20, Math.floor((width - 1) / 2));
  const columns = useMemo(() => buildColumns(tableWidth), [tableWidth]);

  const handleSelect = useCallback((side: Side, row: ScannerHiloExtreme, index: number) => {
    setActiveSide(side);
    setSelected((current) => ({ ...current, [side]: rowKey(row, index) }));
    selectTicker(row.symbol);
  }, [selectTicker]);

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
      rootHeight={Math.max(3, height - BARS_HEIGHT)}
      columns={columns}
      items={rows}
      sortColumnId={null}
      sortDirection="desc"
      onHeaderClick={() => {}}
      getItemKey={rowKey}
      onActivate={(row) => pinTicker(row.symbol, { floating: true, paneType: TICKER_RESEARCH_PANE_ID })}
      renderCell={(row, column, _index, rowState) => renderCell(side, row, column, rowState)}
      emptyStateTitle={feed.payload ? "Nothing above the price filter yet." : "Waiting for the scanner..."}
    />
  );

  return (
    <Box flexDirection="column" width={width} height={height}>
      <HiloBars windows={feed.payload?.windows} width={width} />
      <Box flexDirection="row" flexGrow={1}>
        {renderTable("lows", lows)}
        <Box width={1} flexShrink={0} />
        {renderTable("highs", highs)}
      </Box>
    </Box>
  );
}

export default HiloPane;
