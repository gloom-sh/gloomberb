import { useCallback, useRef, useState } from "react";
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
import { SignInWall } from "../cloud/auth-actions";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { alertKindLabel, fetchAlertHistory, type AlertHistoryItem } from "./history";
import { relativeTime } from "./format";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ");
const itemId = (item: AlertHistoryItem) => item.id;

/** Alerts the push service accepted for this account over the last 90 days. */
export function AlertHistoryPane({ focused, width, height }: PaneProps) {
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const [selected, setSelected] = useState(0);
  // A new session starts the history over. A failed later page leaves what is
  // loaded, and the next scroll to the end asks again.
  const loadPage = useCallback(async ({ offset }: PageRequest) => {
    const page = await fetchAlertHistory(offset);
    return { ...page, rows: page.items, hasMore: page.hasMore && page.nextOffset != null };
  }, [session.requestKey]);
  const history = usePagedRows(access.signedIn ? loadPage : null, { getId: itemId });
  const data = history.pages[0] ?? null;
  const items = history.rows;
  const loadingMore = history.loadingMore;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const loadMoreOnScroll = useTableLoadMore(scrollRef, history.hasMore && !loadingMore, history.loadMore);

  const columns: DataTableColumn[] = [
    { id: "time", label: "Sent (UTC)", width: 16, align: "left" },
    { id: "kind", label: "Event", width: 15, align: "left" },
    { id: "title", label: "Alert", width: Math.max(16, Math.min(28, width - 60)), align: "left" },
    ...(width >= 70 ? [{ id: "body", label: "Detail", width: 20, flexGrow: 1, align: "left" as const }] : []),
  ];
  usePaneFooter(
    "alert-history",
    () => ({
      info: data
        ? [
            ...(loadingMore ? [{ id: "more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
            {
              id: "device",
              parts: [
                {
                  text: `${data.deviceEnabled ? "phone connected" : "no phone connected"} · checked ${relativeTime(Date.parse(data.asOf))}`,
                  tone: data.deviceEnabled ? ("muted" as const) : ("warning" as const),
                },
              ],
            },
          ]
        : [],
    }),
    [data, loadingMore],
  );
  if (!access.signedIn)
    return <SignInWall placement="alerts-history-signin" action="see delivered alerts" needsVerification={session.needsVerification} />;
  return (
    <PaneStatusBody
      loading={history.loading && !data}
      error={!data ? history.error?.message ?? null : null}
      subject="alert history"
    >
      {data?.status === "unavailable" ? (
        <PaneStatusBody error={data.warning ?? "Alert history is unavailable."} subject="alert history" />
      ) : (
        <DataTableView<AlertHistoryItem, DataTableColumn>
          focused={focused}
          rootWidth={width}
          rootHeight={height}
          columns={columns}
          items={items}
          scrollRef={scrollRef}
          onBodyScrollActivity={loadMoreOnScroll}
          selection={{
            kind: "index",
            selectedIndex: Math.min(selected, Math.max(0, items.length - 1)),
            onChange: setSelected,
          }}
          getItemKey={(item) => item.id}
          onRootKeyDown={(event) => handleRefreshKey(event, history.reload)}
          sortColumnId={null}
          sortDirection="desc"
          renderCell={(item, column, _index, row) => ({
            text:
              column.id === "time"
                ? stamp(item.deliveredAt)
                : column.id === "kind"
                  ? alertKindLabel(item.kind)
                  : column.id === "title"
                    ? item.title
                    : item.body,
            color: row.selected ? colors.selectedText : column.id === "time" ? colors.textMuted : colors.text,
          })}
          emptyStateTitle="No alerts delivered in the last 90 days"
          emptyStateHint={data?.deviceEnabled ? undefined : "Alerts push to the Gloomberb phone app once it is signed in."}
        />
      )}
    </PaneStatusBody>
  );
}
