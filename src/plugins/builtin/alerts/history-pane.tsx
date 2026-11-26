import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePagedRows,
  usePaneFooter,
  useTableLoadMore,
  type DataTableCell,
  type DataTableColumn,
  type PageRequest,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { usePinnedList } from "../../../components/use-pinned-moment";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import type { ScrollBoxRenderable } from "../../../ui";
import { MISSING_VALUE } from "../../../utils/format";
import { usePlanAccess } from "../../../api-client/plan-access";
import { usePluginState } from "../../runtime";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { FIRED_LOG_KEY, readFiredAlerts } from "./fired-log";
import { alertKindLabel, fetchAlertHistory, type AlertHistoryItem } from "./history";
import { mergeAlertHistory, owesAlertFigure, type AlertHistoryRow, type AlertHistoryVia } from "./history-rows";
import { formatAlertHistoryValue, relativeTime } from "./format";
import { alertTarget, alertViewHints, deliveredAlertSubject, useOpenAlertTarget, type AlertSubject } from "./targets";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ");
const itemId = (item: AlertHistoryItem) => item.id;
const historyRowId = (row: HistoryRow) => row.id;
const historyRowMoment = (row: HistoryRow) => {
  const at = Date.parse(row.time);
  return Number.isFinite(at) ? at : null;
};
/** Where a line comes from, in the Via column's few cells. */
const VIA_TEXT: Record<AlertHistoryVia, string> = { app: "App", cloud: "Cloud", both: "App, Cloud" };

/** One line of History: an alert this app fired, one Gloom Cloud delivered, or both for the one alert. */
interface HistoryRow {
  id: string;
  time: string;
  kind: string;
  alert: string;
  /** The figure in its unit, or what the alert said; empty with neither, and for a figure the line owes and has not. */
  value: string;
  /** An alert this app fired on a figure: its Value is that figure, never the words beside it. */
  owesFigure: boolean;
  quoteAt: string | null;
  source: string;
  via: AlertHistoryVia;
  subject: AlertSubject;
}

/** A line as History draws it. */
export function alertHistoryLine(row: AlertHistoryRow): HistoryRow {
  const figure = formatAlertHistoryValue(row.value, row.kind, row.unit ?? "");
  const owesFigure = owesAlertFigure(row);
  return {
    id: row.id, time: row.time, kind: row.kind, alert: row.alert, value: figure ?? (owesFigure ? "" : row.detail), owesFigure,
    quoteAt: row.quoteAt, source: row.source ?? "", via: row.via,
    subject: row.fired
      ? { kind: row.fired.kind, symbol: row.fired.symbol, exchange: row.fired.exchange }
      : deliveredAlertSubject(row.delivered!),
  };
}

/**
 * History's columns at a pane width.
 *
 * Value is owed by an alert this app fired on a figure (owesAlertFigure), and
 * by no other line: a rule change says what was done there, a dated event
 * what it announced, a delivery what its server sent. Those words are no
 * figure, so each such cell is marked as one that may be blank whatever it
 * holds, and a capture leaves its line out: the figure lines alone say whether
 * the column is blank.
 * Quote and Source are owed by none. The app writes a quote's time and how
 * current its feed is only where the quote states them, a rule change and a
 * dated event have neither, and a delivery names only a daily close. So a
 * line without one leaves the cell empty, which is no placeholder to a
 * capture, and neither column is marked as one that may be blank.
 */
export function alertHistoryColumns(width: number): DataTableColumn[] {
  return [
    { id: "time", label: "Time (UTC)", width: 16, align: "left" },
    { id: "kind", label: "Event", width: 15, align: "left" },
    { id: "alert", label: "Alert", width: 20, flexGrow: 1, align: "left" },
    ...(width >= 70 ? [{ id: "value", label: "Value", width: 16, align: "left" as const }] : []),
    ...(width >= 115
      ? [
          { id: "quote", label: "Quote (UTC)", width: 16, align: "left" as const },
          { id: "source", label: "Source", width: 14, align: "left" as const },
          { id: "via", label: "Via", width: 10, align: "left" as const },
        ]
      : []),
  ];
}

/**
 * One cell of a line. A Value with nothing to show is a dash, which a strict
 * capture reads where it reads no empty cell. The mark that the cell may be
 * blank follows what the line is, never what the cell holds: none on a line
 * that owes the figure, so its dash is a gap and its figure fills the column,
 * and one on every other line, words or dash.
 */
export function alertHistoryCell(item: HistoryRow, column: Pick<DataTableColumn, "id">, selected: boolean): DataTableCell {
  if (column.id === "value") {
    return {
      text: item.value || MISSING_VALUE,
      color: selected ? colors.selectedText : item.value ? colors.text : colors.textMuted,
      ...(item.owesFigure ? {} : { mayBeBlank: true }),
    };
  }
  return {
    text:
      column.id === "time" ? stamp(item.time)
        : column.id === "kind" ? alertKindLabel(item.kind)
        : column.id === "alert" ? item.alert
        : column.id === "quote" ? (item.quoteAt ? stamp(item.quoteAt) : "")
        : column.id === "via" ? VIA_TEXT[item.via]
        : item.source,
    color: selected ? colors.selectedText
      : column.id === "time" || column.id === "quote" || column.id === "source" || column.id === "via" ? colors.textMuted : colors.text,
  };
}

/**
 * The alerts that went off, newest first: the ones this app fired, kept on the device, and, signed in,
 * the ones Gloom Cloud delivered to the account's phone or email over the last 90 days.
 */
export function AlertHistoryPane({ focused, width, height }: PaneProps) {
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const [firedLog] = usePluginState<unknown>(FIRED_LOG_KEY, []);
  const fired = useMemo(() => readFiredAlerts(firedLog), [firedLog]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // A new session starts the history over. A failed later page leaves what is
  // loaded, and the next scroll to the end asks again.
  const loadPage = useCallback(async ({ offset }: PageRequest) => {
    const page = await fetchAlertHistory(offset);
    return { ...page, rows: page.items, hasMore: page.hasMore && page.nextOffset != null };
  }, [session.requestKey]);
  const history = usePagedRows(access.signedIn ? loadPage : null, { getId: itemId });
  const data = history.pages[0] ?? null;
  const cloudError = access.signedIn
    ? data?.status === "unavailable" ? data.warning ?? "Delivered alerts are unavailable." : !data ? history.error?.message ?? null : null
    : null;
  // One line per alert: a delivery of one this app fired too joins its line.
  const items = useMemo(
    () => mergeAlertHistory(fired, data?.status === "unavailable" ? [] : history.rows).map(alertHistoryLine),
    [fired, data, history.rows],
  );
  const loadingMore = history.loadingMore;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMoreOnScroll = useTableLoadMore(scrollRef, history.hasMore && !loadingMore, history.loadMore);
  // By id, so an alert going off while one is picked leaves it picked.
  const selectedIndex = Math.max(0, items.findIndex((item) => item.id === selectedId));
  const selectedItem = items[selectedIndex];
  // A crosshair pinned in the tab picks the newest alert that went off by
  // then and mutes the later ones; the selection follows the pin when it
  // moves, not when an alert comes in. It reads the id as stored, so a first
  // row shown with none picked is no pick, and a picked alert that went out
  // of the list sends the selection to the pin's alert rather than the top.
  const { isAfterPin } = usePinnedList<HistoryRow>("alert-history:pin", {
    rows: items, getId: historyRowId, moment: historyRowMoment, selectedId, select: setSelectedId,
  });
  const selectedTarget = useMemo(() => selectedItem ? alertTarget(selectedItem.subject) : null, [selectedItem]);
  const openTarget = useOpenAlertTarget();

  const columns = alertHistoryColumns(width);
  usePaneFooter(
    "alert-history",
    () => ({
      info: [
        ...(loadingMore ? [{ id: "more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
        ...(cloudError && items.length > 0 ? [{ id: "cloud-error", parts: [{ text: cloudError, tone: "warning" as const }] }] : []),
        ...(data && data.status !== "unavailable"
          ? [{
              id: "device",
              parts: [{
                text: `${data.deviceEnabled ? "phone connected" : "no phone connected"} · checked ${relativeTime(Date.parse(data.asOf))}`,
                tone: data.deviceEnabled ? ("muted" as const) : ("warning" as const),
              }],
            }]
          : []),
        ...(!access.signedIn ? [{ id: "account", parts: [{ text: "signed out · this app's alerts only", tone: "muted" as const }] }] : []),
      ],
      hints: alertViewHints(selectedTarget, openTarget),
    }),
    [data, loadingMore, cloudError, items.length, access.signedIn, selectedTarget, openTarget],
  );
  return (
    <PaneStatusBody
      loading={history.loading && !data && fired.length === 0}
      error={cloudError && items.length === 0 ? cloudError : null}
      subject="alert history"
    >
      <DataTableView<HistoryRow, DataTableColumn>
        focused={focused}
        rootWidth={width}
        rootHeight={height}
        columns={columns}
        items={items}
        scrollRef={scrollRef}
        onBodyScrollActivity={loadMoreOnScroll}
        selection={{ kind: "id", selectedId: selectedItem?.id ?? null, getId: historyRowId, onChange: setSelectedId }}
        getItemKey={(item) => item.id}
        onRootKeyDown={(event) => handleRefreshKey(event, history.reload)}
        sortColumnId={null}
        sortDirection="desc"
        renderCell={(item, column, _index, row) => alertHistoryCell(item, column, row.selected)}
        isRowMuted={isAfterPin}
        emptyStateTitle={access.signedIn ? "No alerts in the last 90 days" : "No alerts fired yet"}
        emptyStateHint={access.signedIn
          ? data?.deviceEnabled ? undefined : "Alerts push to the Gloom phone app once it is signed in."
          : "Sign in to list the alerts Gloom Cloud delivers too."}
      />
    </PaneStatusBody>
  );
}
