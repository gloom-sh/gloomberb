import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePaneStatusFooter,
  usePaneTabs,
  type DataTableCell,
} from "../../../components";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes } from "../../../ui";
import { usePluginPaneState } from "../../runtime";
import { fetchPrimaryDealers } from "./client";
import {
  PRIMARY_DEALERS_PANE_ID,
  buildDealerColumns,
  formatChange,
  formatLevel,
  type DealerColumn,
  type DealerRow,
  type DealerTab,
} from "./model";

const TABS = [
  { label: "Positions", value: "positions" },
  { label: "Fails", value: "fails" },
];
const EMPTY_ROWS: DealerRow[] = [];

function changeColor(value: number | null): string {
  if (value == null || value === 0) return colors.textMuted;
  return value > 0 ? colors.positive : colors.negative;
}

export function PrimaryDealersPane({ focused, width, height }: PaneProps) {
  const request = useCallback(() => fetchPrimaryDealers(), []);
  const { data, loading, error, load } = useAsyncResource(request);
  const [storedTab, setTab] = usePluginPaneState<string>("tab", "positions");
  const tab: DealerTab = storedTab === "fails" ? "fails" : "positions";
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const rows = tab === "fails" ? data?.fails ?? EMPTY_ROWS : data?.positions ?? EMPTY_ROWS;
  const asOf = useMemo(() => {
    let best: string | null = null;
    for (const row of rows) {
      if (row.asOf && (best == null || row.asOf > best)) best = row.asOf;
    }
    return best;
  }, [rows]);
  const columns = useMemo(() => buildDealerColumns(width), [width]);
  const footerInfo = useMemo(
    () => asOf ? [{ id: "as-of", parts: [{ text: asOf, tone: "muted" as const }] }] : [],
    [asOf],
  );

  useEffect(() => {
    if (selectedId && rows.some((row) => row.keyid === selectedId)) return;
    setSelectedId(rows[0]?.keyid ?? null);
  }, [rows, selectedId]);

  const refresh = useCallback(() => { void load(); }, [load]);
  const selectTab = useCallback((value: string) => setTab(value === "fails" ? "fails" : "positions"), [setTab]);
  usePaneRefreshKey(refresh, { focused });

  const { strip: tabs, rows: tabRows } = usePaneTabs({
    tabs: TABS,
    activeValue: tab,
    onSelect: selectTab,
    focused,
    compact: true,
    dense: true,
  });

  usePaneStatusFooter({
    registrationId: PRIMARY_DEALERS_PANE_ID,
    loading: loading && !data,
    error,
    info: footerInfo,
  });

  const renderCell = useCallback((
    row: DealerRow,
    column: DealerColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "position":
        return {
          text: row.label,
          color: selectedColor ?? colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "asOf":
        return { text: row.asOf ?? "—", color: selectedColor ?? colors.textMuted };
      case "latest":
        return { text: formatLevel(row.latest), value: row.latest, color: selectedColor ?? colors.text };
      case "previous":
        return { text: formatLevel(row.previous), value: row.previous, color: selectedColor ?? colors.textDim };
      case "change":
        return { text: formatChange(row.change), value: row.change, color: selectedColor ?? changeColor(row.change) };
    }
  }, []);

  if (!data && loading) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody loading align="center" />
      </Box>
    );
  }

  if (!data && error) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        {tabs}
        <PaneStatusBody error={error} errorTitle="Positions unavailable." />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {tabs}
      <DataTableView<DealerRow, DealerColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={Math.max(1, height - tabRows)}
        selection={{
          kind: "id",
          selectedId,
          getId: (row) => row.keyid,
          onChange: (id) => setSelectedId(id),
        }}
        onRootKeyDown={(event) => handleRefreshKey(event, refresh, { stopPropagation: true })}
        columns={columns}
        items={rows}
        sortColumnId={null}
        sortDirection="asc"
        getItemKey={(row) => row.keyid}
        renderCell={renderCell}
        emptyStateTitle={tab === "fails" ? "No fails in this release." : "No positions in this release."}
      />
    </Box>
  );
}
