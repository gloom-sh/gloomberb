import { useCallback, useMemo, useRef, useState } from "react";
import {
  DataTableView,
  PaneStatusBody,
  usePagedRows,
  usePaneFooter,
  useTableLoadMore,
  type DataTableColumn,
  type PageRequest,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import type { ScrollBoxRenderable } from "../../../ui";
import { usePlanAccess } from "../../../api-client/plan-access";
import { usePluginState } from "../../runtime";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { FIRED_LOG_KEY, readFiredAlerts } from "./fired-log";
import { alertKindLabel, fetchAlertHistory, type AlertHistoryItem } from "./history";
import { mergeAlertHistory, type AlertHistoryRow, type AlertHistoryVia } from "./history-rows";
import { relativeTime } from "./format";
import { alertTarget, alertViewHints, deliveredAlertSubject, useOpenAlertTarget, type AlertSubject } from "./targets";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ");
const itemId = (item: AlertHistoryItem) => item.id;
/** Where a line comes from, in the Via column's few cells. */
const VIA_TEXT: Record<AlertHistoryVia, string> = { app: "App", cloud: "Cloud", both: "App, Cloud" };

/** One line of History: an alert this app fired, one Gloom Cloud delivered, or both for the one alert. */
interface HistoryRow {
  id: string;
  time: string;
  kind: string;
  alert: string;
  /** The figure in its unit, or what the alert said. */
  value: string;
  quoteAt: string | null;
  source: string;
  via: AlertHistoryVia;
  subject: AlertSubject;
}

function historyRow(row: AlertHistoryRow): HistoryRow {
  const figure = row.value == null ? null
    : `${Number(row.value.toFixed(4))}${row.unit === "%" ? "%" : row.unit ? ` ${row.unit}` : ""}`;
  return {
    id: row.id, time: row.time, kind: row.kind, alert: row.alert, value: figure ?? row.detail,
    quoteAt: row.quoteAt, source: row.source ?? "", via: row.via,
    subject: row.fired
      ? { kind: row.fired.kind, symbol: row.fired.symbol, exchange: row.fired.exchange }
      : deliveredAlertSubject(row.delivered!),
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
  const [selected, setSelected] = useState(0);
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
    () => mergeAlertHistory(fired, data?.status === "unavailable" ? [] : history.rows).map(historyRow),
    [fired, data, history.rows],
  );
  const loadingMore = history.loadingMore;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMoreOnScroll = useTableLoadMore(scrollRef, history.hasMore && !loadingMore, history.loadMore);
  const selectedIndex = Math.min(selected, Math.max(0, items.length - 1));
  const selectedItem = items[selectedIndex];
  const selectedTarget = useMemo(() => selectedItem ? alertTarget(selectedItem.subject) : null, [selectedItem]);
  const openTarget = useOpenAlertTarget();

  const columns: DataTableColumn[] = [
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
        selection={{ kind: "index", selectedIndex, onChange: setSelected }}
        getItemKey={(item) => item.id}
        onRootKeyDown={(event) => handleRefreshKey(event, history.reload)}
        sortColumnId={null}
        sortDirection="desc"
        renderCell={(item, column, _index, row) => ({
          text:
            column.id === "time" ? stamp(item.time)
              : column.id === "kind" ? alertKindLabel(item.kind)
              : column.id === "alert" ? item.alert
              : column.id === "value" ? item.value
              : column.id === "quote" ? (item.quoteAt ? stamp(item.quoteAt) : "")
              : column.id === "via" ? VIA_TEXT[item.via]
              : item.source,
          color: row.selected ? colors.selectedText
            : column.id === "time" || column.id === "quote" || column.id === "source" || column.id === "via" ? colors.textMuted : colors.text,
        })}
        emptyStateTitle={access.signedIn ? "No alerts in the last 90 days" : "No alerts fired yet"}
        emptyStateHint={access.signedIn
          ? data?.deviceEnabled ? undefined : "Alerts push to the Gloomberb phone app once it is signed in."
          : "Sign in to list the alerts Gloom Cloud delivers too."}
      />
    </PaneStatusBody>
  );
}
