import { useCallback, useState } from "react";
import { isPlainKey } from "../../../utils/keyboard";
import {
  DataTableView,
  PaneStatusBody,
  usePaneFooter,
  type DataTableColumn,
} from "../../../components";
import { useAsyncResource } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { SignInWall } from "../cloud/auth-actions";
import { usePlanAccess } from "../shared/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { alertKindLabel, fetchAlertHistory, type AlertHistoryItem } from "./history";
import { relativeTime } from "./format";

const stamp = (value: string) => value.slice(0, 16).replace("T", " ");

/** Alerts the push service accepted for this account over the last 90 days. */
export function AlertHistoryPane({ focused, width, height }: PaneProps) {
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const [selected, setSelected] = useState(0);
  const loader = useCallback(() => fetchAlertHistory(0), [session.requestKey]);
  const history = useAsyncResource(access.signedIn ? loader : null);
  const data = history.data;
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
            {
              id: "device",
              parts: [
                {
                  text: `${data.items.length}${data.hasMore ? "+" : ""} in 90 days · ${data.deviceEnabled ? "phone connected" : "no phone connected"} · checked ${relativeTime(Date.parse(data.asOf))}`,
                  tone: data.deviceEnabled ? ("muted" as const) : ("warning" as const),
                },
              ],
            },
          ]
        : [],
      hints: [{ id: "refresh", key: "r", label: "efresh", onPress: () => void history.reload() }],
    }),
    [data, history.reload],
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
          items={data?.items ?? []}
          selection={{
            kind: "index",
            selectedIndex: Math.min(selected, Math.max(0, (data?.items.length ?? 1) - 1)),
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
          onHeaderClick={() => {}}
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
