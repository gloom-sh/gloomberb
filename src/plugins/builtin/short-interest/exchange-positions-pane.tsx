import { sgxVolumeColumns, sgxVolumeEmpty } from "../short-volume/sgx";
import { jpxColumns, jpxEmpty } from "./jpx";
import { useCallback, useState } from "react";
import { apiClient } from "../../../api-client";
import type { BalanceVenue } from "../../../api-client/exchange-short-balances";
import { DataTableView, PaneStatusBody, usePaneStatusLinkFooter } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import type { PaneProps } from "../../../types/plugin";
import { sfcColumns, sfcEmpty, sfcValue } from "./sfc";
import { balanceColumns, balanceEmpty, readExchangeBalances } from "./exchange-balances";

type Venue = BalanceVenue | "HKEX" | "JPX" | "SGX";
type ReportRow = { day: string; sourceUrl: string } & Record<string, number | string | null>;
const rowKey = (row: ReportRow) => row.line == null ? row.day : row.day + ":" + row.line;

async function loadReport(symbol: string, venue: Venue) {
  if (venue === "SGX") {
    const data = await apiClient.getSgxShortSales(symbol);
    return { rows: data.points.map(row => ({ ...row })), empty: sgxVolumeEmpty(data), page: "https://www.sgx.com/securities/trading", source: "Singapore Exchange" };
  }
  if (venue === "JPX") {
    const data = await apiClient.getJpxShortPositions(symbol);
    return { rows: data.points.map(row => ({ ...row })), empty: jpxEmpty(data), page: data.page, source: data.source };
  }
  if (venue === "HKEX") {
    const data = await apiClient.getSfcShortPositions(symbol);
    return { rows: data.points.map(row => ({ ...row })), empty: sfcEmpty(data), page: data.page, source: data.source };
  }
  const data = await readExchangeBalances(apiClient, symbol, venue);
  return { rows: data.points.map(row => ({ ...row })), empty: balanceEmpty(data), page: undefined, source: venue };
}

export function ExchangePositionsPane({ symbol, venue, focused, width, height }: Pick<PaneProps, "focused" | "width" | "height"> & {symbol: string; venue: Venue}) {
  const read = useCallback(() => loadReport(symbol, venue), [symbol, venue]);
  const resource = useAsyncResource(read);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const data = resource.data;
  const rows: ReportRow[] = data?.rows ?? [];
  const current = rows.find(row => rowKey(row) === selectedId) ?? rows[0];
  const hk = venue === "HKEX";
  const columns = (hk ? sfcColumns : venue === "SGX" ? sgxVolumeColumns : venue === "JPX" ? jpxColumns : balanceColumns(venue)).map(column => ({
    id: column.key, label: column.header, width: column.width, align: "align" in column ? column.align : "left" as const,
  }));
  usePaneRefreshKey(resource.reload, { focused });
  usePaneStatusLinkFooter({ registrationId: "exchange-short-positions", focused, loading: resource.loading, error: resource.error,
    label: hk ? "weekly report" : "daily report", source: data?.source, url: current?.sourceUrl ?? data?.page, showOpenHint: !!(current || data?.page) });
  return <PaneStatusBody loading={resource.loading && !data} error={data ? null : resource.error} subject={venue === "SGX" ? "SGX executed short sales" : hk ? "SFC reportable short positions" : venue === "JPX" ? "JPX short seller disclosures" : "Short sale balances"}
    empty={!!data && !rows.length} emptyTitle={data?.empty}>
    <DataTableView focused={focused} rootWidth={width} rootHeight={height} freezeFirstColumn columns={columns} items={rows}
      selection={{ kind: "id", selectedId: current ? rowKey(current) : null, getId: rowKey, onChange: setSelectedId }}
      emptyStateTitle={data?.empty ?? "No reported positions."} sortColumnId="day" sortDirection="desc" getItemKey={rowKey}
      renderCell={(row, column) => ({ text: sfcValue(row[column.id]), value: row[column.id] ?? null })} />
  </PaneStatusBody>;
}
