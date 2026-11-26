import { useCallback, useMemo } from "react";
import { Box, ScrollBox, useUiCapabilities } from "../../../ui";
import { useAsyncResource, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { ChartTableHeader, DataTableStackView, EmptyState, KeyValueRow, PaneStatusBody, useChartTableSelection, usePaneNoticeFooter, usePaneStatusLinkFooter, type DataTableCell, type StatItem } from "../../../components";
import { ageFooterSegment } from "../../../components/layout/pane/footer";
import { colors } from "../../../theme/colors";
import type { BuybackDay, BuybacksPayload } from "../../../api-client/buybacks";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import { staticSeries } from "../../../components/chart/static/series";
import type { PaneProps } from "../../../types/plugin";
import { MISSING_VALUE } from "../../../utils/format";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { buybackSymbol, cachedBuybacks, loadBuybacks } from "./client";
import {
  BUYBACK_COLUMNS, blackoutFigure, boughtElsewhere, boughtPoints, cellText, closePoints, dayNote, lastBoughtFigure, mandateUsedPercent, ofAuthorised, percent, price,
  shares, shortDay, sortedDays, venuesText, type BuybackColumn, type BuybackSort,
} from "./model";

const DETAIL_LABEL_WIDTH = 24;
const PANELS = [{ id: "price", height: 2 }, { id: "bought", height: 1 }];

function DayDetail({ day, data, width, height }: { day: BuybackDay; data: BuybacksPayload; width: number; height: number }) {
  const { nativePaneChrome } = useUiCapabilities();
  return <ScrollBox scrollY width={width} height={nativePaneChrome ? undefined : height} flexGrow={1} flexBasis={0} minHeight={0} contentOptions={{ paddingX: 1 }}>
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Bought, every venue" value={shares(day.shares)} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="On the Exchange" value={shares(day.sharesOnExchange)} detail={day.percentOfVolume == null ? undefined : `${percent(day.percentOfVolume)} of ${shares(day.volume)} traded`} />
    {day.venues.map((venue, index) => <KeyValueRow key={`${venue.venue}:${index}`} labelWidth={DETAIL_LABEL_WIDTH} label={venue.venue}
      value={`${shares(venue.shares)} at ${price(venue.low)} to ${price(venue.high)} ${venue.currency ?? ""}`.trim()} detail={venue.paid == null ? undefined : `${shares(venue.paid)} ${venue.currency ?? ""} paid`} />)}
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Average on the Exchange" value={day.average == null ? MISSING_VALUE : `${price(day.average)} ${day.currency ?? ""}`} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Shares go to" value={day.destination === "cancel" ? "Cancellation" : day.destination === "treasury" ? "Treasury" : day.destination === "mixed" ? "Cancellation and treasury" : MISSING_VALUE} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Mandate used" value={day.mandateUsed == null ? MISSING_VALUE : shares(day.mandateUsed)}
      detail={ofAuthorised(mandateUsedPercent(day, data), data.mandate?.authorised) ?? undefined} />
    <KeyValueRow labelWidth={DETAIL_LABEL_WIDTH} label="Return published" value={day.filing.publishedAt.replace("T", " ").slice(0, 16) + " HKT"} detail={dayNote(day) || undefined} />
  </ScrollBox>;
}

export function BuybacksView({ width, height, focused }: Pick<PaneProps, "width" | "height" | "focused">) {
  const { ticker } = usePaneTickerIdentity();
  const symbol = buybackSymbol(ticker?.metadata.ticker, ticker?.metadata.exchange);
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const loader = useCallback((force: boolean) => loadBuybacks(symbol!, accessKey, force), [symbol, accessKey]);
  const resource = useAsyncResource(symbol ? loader : null, { initialData: () => symbol ? cachedBuybacks(symbol, accessKey) : null, clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const [sort, setSort] = usePluginPaneState<BuybackSort>("buybacks:sort", { column: "date", direction: "desc" });
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("buybacks:selected", null);
  const [openId, setOpenId] = usePluginPaneState<string | null>("buybacks:open", null);
  const rowKey = (row: BuybackDay) => `${symbol}:${row.date}`;
  const rows = useMemo(() => data ? sortedDays(data, sort) : [], [data, sort]);
  const selectedIndex = Math.max(0, rows.findIndex((row) => rowKey(row) === selectedId));
  const openRow = rows.find((row) => rowKey(row) === openId);
  const selected = openRow ?? rows[selectedIndex];
  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  const currency = data?.currency ?? "";
  // Buying is the subject, so it leads the legend and the strip; the close it is read against follows.
  const series = useMemo(() => data ? [
    { ...staticSeries(boughtPoints(data, "exchange"), { id: "bought", label: "Bought in HK", color: colors.warning, style: "columns", calendarSpaced: true }), panelId: "bought", unit: "shares", unitGroup: "shares" },
    ...(boughtElsewhere(data) ? [{ ...staticSeries(boughtPoints(data, "elsewhere"), { id: "elsewhere", label: "Elsewhere", color: colors.textMuted, style: "columns" as const, calendarSpaced: true }), panelId: "bought", unit: "shares", unitGroup: "shares" }] : []),
    { ...staticSeries(closePoints(data), { id: "close", label: "Close", color: colors.textBright, calendarSpaced: true }), panelId: "price", unit: currency, unitGroup: "price" },
  ] : [], [data, currency]);
  const link = useChartTableSelection({
    rows, getId: rowKey, getDate: (row) => new Date(`${row.date}T00:00:00.000Z`), selectedId: rows[selectedIndex] ? rowKey(rows[selectedIndex]!) : null,
    onSelect: setSelectedId, focused: focused && !openRow,
  });
  const figures: StatItem[] = data ? figuresFor(data) : [];
  usePaneRefreshKey(() => resource.reload(), { focused });
  const since = data?.heldFrom ? shortDay(data.heldFrom) : null;
  usePaneNoticeFooter({ registrationId: "buybacks:notices", focused, notices: [
    // Without Pro the server sends the newest sessions only.
    ...(data?.lockedDays ? [`Newest ${data.days.length} of ${data.totalDays} sessions bought. Gloom Pro shows every one${since ? ` since ${since}` : ""}.`] : []),
    ...(data?.otherClasses.length ? [`Also bought ${data.otherClasses.map((other) => `${shares(other.shares)} ${other.shareType ?? ""} shares on ${other.venue ?? "another exchange"}`.replace("  ", " ")).join(", ")}, not this line.`] : []),
    ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
  ] });
  usePaneStatusLinkFooter({ registrationId: "buybacks", focused, loading: resource.loading, error: resource.error,
    label: "next day disclosure return", url: selected?.filing.url ?? data?.mandate?.filing ?? null, showOpenHint: true,
    info: data ? [...(data.asOfSession ? [{ id: "as-of", parts: [{ text: `returns to ${shortDay(data.asOfSession)}`, tone: "muted" as const }] }] : []),
      // Sessions withheld: the chart's buying is blank before the newest sent.
      ...(data.lockedDays ? [{ id: "preview", parts: [{ text: "Pro preview", tone: "warning" as const }] }] : []),
      ...(updatedAgo ? [ageFooterSegment(updatedAgo)] : [])] : [],
    stale: !!data && resource.data?.stale,
  });
  if (!symbol) return <EmptyState title="Hong Kong listings only." message="Buybacks are read from Hong Kong next day disclosure returns." />;
  return <Box flexDirection="column" width={width} height={height}>
    <PaneStatusBody loading={resource.loading && !data} error={!data ? resource.error : null} subject="share buybacks"
      empty={!resource.loading && !resource.error && !!data && !data.days.length && !data.otherClasses.length} emptyTitle={since ? `No buybacks since ${since}.` : "No buybacks."}>
      {data ? <DataTableStackView<BuybackDay, BuybackColumn>
        focused={focused} rootWidth={width} rootHeight={height} emptyStateTitle={since ? `No buybacks on this line since ${since}.` : "No buybacks on this line."} columns={BUYBACK_COLUMNS} items={rows} freezeFirstColumn
        getItemKey={rowKey} resetScrollKey={symbol}
        renderCell={(row, column, _index, state): DataTableCell => ({
          text: cellText(row, column.id),
          color: state.selected ? colors.selectedText : column.id === "percentOfVolume" ? colors.warning : column.id === "note" ? (row.inBlackout ? colors.warning : colors.textMuted)
            : column.id === "elsewhere" || column.id === "destination" ? colors.textDim : colors.text,
        })}
        selection={{ kind: "index", selectedIndex: rows.length ? selectedIndex : -1, onChange: (index) => setSelectedId(rows[index] ? rowKey(rows[index]!) : null) }}
        onActivate={(row) => setOpenId(rowKey(row))} detailOpen={!!openRow} onBack={() => setOpenId(null)}
        detailTitle={openRow ? `${openRow.date} · ${venuesText(openRow)}` : undefined}
        detailContent={openRow ? <DayDetail day={openRow} data={data} width={width} height={Math.max(3, height - 2)} /> : null}
        sortColumnId={sort.column} sortDirection={sort.direction}
        onHeaderClick={(column) => setSort((current) => ({ column: column as BuybackSort["column"], direction: current.column === column && current.direction === "desc" ? "asc" : "desc" }))}
        rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={BUYBACK_COLUMNS} figures={figures} chart={{
          series, panels: PANELS, remoteKind: "buyback-history",
          formatValue: (value, entry) => entry?.id === "close" ? `${price(value)} ${currency}` : shares(value),
          ...link,
        }} />}
      /> : null}
    </PaneStatusBody>
  </Box>;
}

/**
 * The header: what was bought over 5 and 20 sessions, or, for a span with
 * none, one line saying when the last buy was; the mandate as a share of what
 * it authorises; the next blackout; treasury shares only when there are some
 * (the table's TO column says where the rest went).
 */
function figuresFor(data: BuybacksPayload): StatItem[] {
  const { last5, last20 } = data.summary;
  const mandate = data.mandate;
  const blackout = blackoutFigure(data, data.asOfSession);
  const onExchange = (sum: typeof last5) => sum.sharesOnExchange !== sum.shares ? `${shares(sum.sharesOnExchange)} in HK · ` : "";
  const bought = (id: string, label: string, sum: typeof last5, essential: boolean): StatItem => ({
    id, label, essential, value: `${shares(sum.shares)} sh`, color: colors.warning,
    detail: `${onExchange(sum)}${percent(sum.percentOfVolume)} of volume${id === "20d" ? ` · ${sum.days} of ${sum.sessions} sessions` : ""}`,
  });
  const last = lastBoughtFigure(data);
  const treasury = data.shares?.treasury;
  return [
    last5.shares ? bought("5d", "5D bought", last5, true) : { id: "last", label: "Last bought", essential: true, value: last.value, detail: last.detail },
    { id: "mandate", label: "Mandate used", value: percent(mandate?.usedPercent ?? null, 1),
      detail: mandate?.authorised ? `of ${shares(mandate.authorised)} authorised · ${shares(mandate.left)} left` : mandate ? "no maximum stated" : "no mandate stated" },
    { id: "blackout", label: blackout.label, value: blackout.value, detail: blackout.detail, color: data.blackout.current ? colors.warning : undefined },
    ...(last20.shares ? [bought("20d", "20D bought", last20, false)] : []),
    ...(treasury ? [{ id: "treasury", label: "Treasury", value: `${shares(treasury)} sh`,
      detail: data.shares?.issued == null ? undefined : `${shares(data.shares.issued)} issued` }] : []),
  ];
}
