import { useCallback, useMemo, useRef, useState } from "react";
import { isPlainKey } from "../../../utils/keyboard";
import {
  DataTableView,
  PaneStatusBody,
  usePaneFooter,
  useTableLoadMore,
  type DataTableColumn,
} from "../../../components";
import { useAsyncResource } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import type { ScrollBoxRenderable } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { usePlanAccess } from "../shared/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { alertKindLabel, fetchAlertHistory, type AlertHistory, type AlertHistoryItem } from "./history";
import { relativeTime } from "./format";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ");

/** Later pages, kept against the first page they continue so a reload starts over. */
interface OlderPages {
  first: AlertHistory;
  items: AlertHistoryItem[];
  hasMore: boolean;
  nextOffset: number | null;
}

/** Alerts the push service accepted for this account over the last 90 days. */
export function AlertHistoryPane({ focused, width, height }: PaneProps) {
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const [selected, setSelected] = useState(0);
  const loader = useCallback(() => fetchAlertHistory(0), [session.requestKey]);
  const history = useAsyncResource(access.signedIn ? loader : null);
  const data = history.data;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const [older, setOlder] = useState<OlderPages | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRequest = useRef(0);
  const pages = data && older?.first === data ? older : null;
  const items = useMemo(
    () => (data ? (pages ? [...data.items, ...pages.items] : data.items) : []),
    [data, pages],
  );
  const hasMore = pages ? pages.hasMore : !!data?.hasMore;
  const nextOffset = pages ? pages.nextOffset : (data?.nextOffset ?? null);

  const loadMore = useCallback(() => {
    if (!data || !hasMore || nextOffset == null || loadingMore) return;
    const request = ++pageRequest.current;
    setLoadingMore(true);
    void fetchAlertHistory(nextOffset)
      .then((page) => {
        if (pageRequest.current !== request) return;
        setOlder((current) => {
          const prior = current?.first === data ? current.items : [];
          const seen = new Set([...data.items, ...prior].map((item) => item.id));
          return {
            first: data,
            items: [...prior, ...page.items.filter((item) => !seen.has(item.id))],
            hasMore: page.hasMore,
            nextOffset: page.nextOffset,
          };
        });
      })
      // A failed page leaves what is loaded; the next scroll to the end tries again.
      .catch(() => {})
      .finally(() => {
        if (pageRequest.current === request) setLoadingMore(false);
      });
  }, [data, hasMore, loadingMore, nextOffset]);
  const loadMoreOnScroll = useTableLoadMore(scrollRef, hasMore && !loadingMore, loadMore);

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
    return <SignInWall action="see delivered alerts" needsVerification={session.needsVerification} />;
  return (
    <PaneStatusBody
      loading={history.loading && !data}
      error={!data ? history.error : null}
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
          onRootKeyDown={(event) => {
            if (!isPlainKey(event, "r")) return false;
            event.preventDefault?.();
            void history.reload();
            return true;
          }}
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
