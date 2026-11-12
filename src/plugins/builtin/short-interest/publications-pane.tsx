import { MISSING_VALUE } from "../../../utils/format";
import { useCallback, useMemo } from "react";
import { DataTableStackView, EmptyState, PaneStatusBody, StatGrid, usePaneNoticeFooter, usePaneStatusLinkFooter, type DataTableCell, type StatItem } from "../../../components";
import { ageFooterSegment } from "../../../components/layout/pane/footer";
import { DetailReader } from "../../../components/reader/detail-reader";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { colors } from "../../../theme/colors";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import type { PaneProps } from "../../../types/plugin";
import { isKnownNonUsEquityTicker } from "../../../utils/sec";
import { listingIdentity } from "../shared/ticker-request";
import { cachedPublication, loadPublication, type PublicationKind } from "./publications-client";
import { publicationCell, publicationColumns, publicationRows, sharedFailIdentity, type PublicationColumn, type PublicationRow } from "./publications-model";

function renderCell(row: PublicationRow, column: PublicationColumn, _index: number, state: { selected: boolean }): DataTableCell {
  const value = row[column.id] ?? null;
  return { text: publicationCell(column, value), value, color: state.selected ? colors.selectedText : value === null ? colors.textMuted : colors.text };
}
export function ShortSidePublicationPane({ kind, width, height, focused }: Pick<PaneProps, "width" | "height" | "focused"> & { kind: PublicationKind }) {
  const { ticker } = usePaneTickerIdentity();
  const symbol = listingIdentity(ticker?.metadata.ticker)?.symbol ?? null;
  const foreign = !!ticker && isKnownNonUsEquityTicker(ticker);
  const subject = kind === "ftd" ? "fails to deliver" : "weekly off-exchange volume";
  const loader = useCallback((force: boolean) => loadPublication(symbol!, kind, force), [symbol, kind]);
  const resource = useAsyncResource(symbol && !foreign ? loader : null, {
    initialData: () => symbol && !foreign ? cachedPublication(symbol, kind) : null,
  });
  const data = resource.data?.payload;
  const rows = useMemo(() => data ? publicationRows(data) : [], [data]);
  const shared = useMemo(() => kind === "ftd" ? sharedFailIdentity(rows) : undefined, [kind, rows]);
  // The open detail names every fact of its row; the table drops what every row shares.
  const detailColumns = publicationColumns(kind);
  const columns = publicationColumns(kind, shared);
  const identity = useMemo<StatItem[]>(() => [
    ...(shared?.cusip ? [{ id: "cusip", label: "CUSIP", value: shared.cusip }] : []),
    ...(shared?.security ? [{ id: "security", label: "Security", value: shared.security }] : []),
  ], [shared]);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`${kind}:selected`, null);
  const [openId, setOpenId] = usePluginPaneState<string | null>(`${kind}:open`, null);
  const rowKey = (row: PublicationRow) => `${symbol}:${row.id}`;
  const selectedIndex = Math.max(0, rows.findIndex((row) => rowKey(row) === selectedId));
  const openRow = rows.find((row) => rowKey(row) === openId);
  const selected = openRow ?? rows[selectedIndex];
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => resource.reload(), { focused });
  usePaneNoticeFooter({ registrationId: `${kind}:notices`, focused,
    notices: [...(data?.warnings ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : [])] });
  usePaneStatusLinkFooter({ registrationId: kind, focused, loading: resource.loading, error: resource.error,
    url: selected?.sourceUrl ?? data?.source.url ?? null, showOpenHint: true,
    info: data && updatedAgo ? [ageFooterSegment(updatedAgo)] : [],
    stale: !!data && resource.data?.stale,
  });
  if (!symbol) return <EmptyState title="No ticker selected." message={`Select a US stock to view ${subject}.`} />;
  if (foreign) return <EmptyState title="US listings only." message={`Select a US stock to view ${subject}.`} />;
  return <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} subject={subject}
    empty={!resource.loading && !resource.error && !!data && !rows.length} emptyTitle={`No published ${subject} for this stock.`}>
    {data ? <DataTableStackView<PublicationRow, PublicationColumn>
      focused={focused} rootWidth={width} rootHeight={height} columns={columns} items={rows} freezeFirstColumn
      sortColumnId={null} sortDirection="desc" emptyStateTitle={`No published ${subject} for this stock.`}
      rootBefore={identity.length ? <StatGrid items={identity} width={width} /> : undefined}
      getExportMetadata={() => [...(shared?.cusip ? [["cusip", shared.cusip]] : []), ...(shared?.security ? [["security", shared.security]] : [])]}
      getItemKey={rowKey} renderCell={renderCell} resetScrollKey={`${kind}:${symbol}`}
      selection={{ kind: "index", selectedIndex: rows.length ? selectedIndex : -1, onChange: (index) => setSelectedId(rows[index] ? rowKey(rows[index]!) : null) }}
      onActivate={(row) => setOpenId(rowKey(row))} detailOpen={!!openRow} onBack={() => setOpenId(null)}
      detailTitle={openRow ? kind === "ftd" ? `${openRow.date} · ${openRow.cusip}` : `Week of ${openRow.date}` : undefined}
      detailContent={openRow ? <DetailReader width={width} resetScrollKey={rowKey(openRow)} facts={[
        ...detailColumns.filter((column) => column.id !== "date" && column.id !== "cusip").map((column) => ({ label: column.detailLabel,
          value: openRow[column.id] == null ? "Not published" : typeof openRow[column.id] === "number" && column.id !== "atsSharePercent" && column.id !== "price"
            ? Number(openRow[column.id]).toLocaleString("en-US", { maximumFractionDigits: 6 }) : publicationCell(column, openRow[column.id] ?? null) })),
        { label: "Published through", value: data.sourceAsOf ?? MISSING_VALUE },
        { label: "Retrieved", value: data.loadedAt?.replace("T", " ").replace(/\.\d+Z$/, " UTC") ?? MISSING_VALUE },
      ]} /> : null}
    /> : null}
  </PaneStatusBody>;
}
