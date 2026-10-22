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
import { FIRED_LOG_KEY, readFiredAlerts, type FiredAlert } from "./fired-log";
import { alertKindLabel, fetchAlertHistory, type AlertHistoryItem } from "./history";
import { relativeTime } from "./format";
import { alertTarget, alertViewHints, deliveredAlertSubject, useOpenAlertTarget, type AlertSubject } from "./targets";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ");
const itemId = (item: AlertHistoryItem) => item.id;

/** One line of History: an alert this app fired, or one Gloom Cloud delivered. */
interface HistoryRow {
  id: string;
  time: string;
  kind: string;
  alert: string;
  /** The figure in its unit, or what the alert said. */
  value: string;
  quoteAt: string | null;
  source: string;
  subject: AlertSubject;
}

function firedRow(entry: FiredAlert): HistoryRow {
  const figure = entry.value == null ? null
    : `${Number(entry.value.toFixed(4))}${entry.unit === "%" ? "%" : entry.unit ? ` ${entry.unit}` : ""}`;
  return {
    id: `app:${entry.id}`, time: entry.firedAt, kind: entry.kind, alert: entry.rule, value: figure ?? entry.detail ?? "",
    quoteAt: entry.quoteAt, source: entry.source ?? "",
    subject: { kind: entry.kind, symbol: entry.symbol, exchange: entry.exchange },
  };
}

function deliveredRow(item: AlertHistoryItem): HistoryRow {
  return {
    id: `cloud:${item.id}`, time: item.deliveredAt, kind: item.kind, alert: item.title, value: item.body,
    quoteAt: null, source: "Gloom Cloud", subject: deliveredAlertSubject(item),
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
  const items = useMemo(() => [
    ...fired.map(firedRow),
    ...(data?.status === "unavailable" ? [] : history.rows.map(deliveredRow)),
  ].sort((a, b) => Date.parse(b.time) - Date.parse(a.time)), [fired, data, history.rows]);
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
    ...(width >= 110
      ? [
          { id: "quote", label: "Quote (UTC)", width: 16, align: "left" as const },
          { id: "source", label: "Source", width: 14, align: "left" as const },
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
              : item.source,
          color: row.selected ? colors.selectedText
            : column.id === "time" || column.id === "quote" || column.id === "source" ? colors.textMuted : colors.text,
        })}
        emptyStateTitle={access.signedIn ? "No alerts in the last 90 days" : "No alerts fired yet"}
        emptyStateHint={access.signedIn
          ? data?.deviceEnabled ? undefined : "Alerts push to the Gloomberb phone app once it is signed in."
          : "Sign in to list the alerts Gloom Cloud delivers too."}
      />
    </PaneStatusBody>
  );
}
