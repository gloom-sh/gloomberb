import { useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { SfcPosition } from "../../../api-client/sfc-short-positions";
import { DataTableView, PaneStatusBody, usePaneStatusLinkFooter } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import type { PaneProps } from "../../../types/plugin";
import { sfcColumns, sfcEmpty, sfcValue } from "./sfc";

const columns = sfcColumns.map(({ key, header, width }) => ({
  id: key, label: header, width, align: key === "day" ? "left" as const : "right" as const,
}));
const rowKey = (row: SfcPosition) => row.day;
function renderCell(row: SfcPosition, column: typeof columns[number]) {
  const value = row[column.id];
  return { text: sfcValue(value), value };
}

export function SfcPositionsPane({ symbol, focused, width, height }: Pick<PaneProps, "focused" | "width" | "height"> & {symbol: string}) {
  const read = useCallback(() => apiClient.getSfcShortPositions(symbol), [symbol]);
  const resource = useAsyncResource(read);
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const data = resource.data;
  const rows = data?.points ?? [];
  const current = rows.find(row => row.day === selectedDay) ?? rows[0];
  usePaneRefreshKey(resource.reload, { focused });
  usePaneStatusLinkFooter({ registrationId: "sfc-short", focused, loading: resource.loading, error: resource.error,
    label: "weekly report", source: data?.source, url: current?.sourceUrl ?? data?.page, showOpenHint: !!data });
  return <PaneStatusBody loading={resource.loading && !data} error={data ? null : resource.error} subject="SFC reportable short positions"
    empty={!!data && !rows.length} emptyTitle={data ? sfcEmpty(data) : undefined}>
    <DataTableView focused={focused} rootWidth={width} rootHeight={height} freezeFirstColumn columns={columns} items={rows}
      selection={{ kind: "id", selectedId: current?.day ?? null, getId: rowKey, onChange: setSelectedDay }}
      emptyStateTitle="No weekly SFC positions." sortColumnId="day" sortDirection="desc" getItemKey={rowKey} renderCell={renderCell} />
  </PaneStatusBody>;
}
