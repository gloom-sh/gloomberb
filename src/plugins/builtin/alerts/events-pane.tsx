import { isPlainKey } from "../../../utils/keyboard";
import { useCallback, useMemo, useState } from "react";
import { Box } from "../../../ui";
import {
  Button,
  ConfirmDialog,
  DataTableView,
  EmptyState,
  usePaneFooter,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import { useCloudSyncStatus } from "../../../sync/react";
import { usePluginAppActions, usePluginConfigState } from "../../runtime";
import {
  EVENT_ALERTS_KEY,
  eventAlertTarget,
  readEventAlerts,
  toggleEventAlert,
  type EventAlertRule,
} from "./events";
import { relativeTime } from "./format";
import { alertKindLabel, fetchAlertHistory, ruleStateText } from "./history";
import { isResearchAlertKind } from "./research-rules";
import { useAsyncResource } from "../../../public/react";
import { usePlanAccess } from "../shared/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";

const columnsFor = (width: number, lastCheck: boolean): DataTableColumn[] => [
  { id: "kind", label: "Event", width: 15, align: "left" },
  { id: "target", label: "Following", width: 28, flexGrow: 1, align: "left" },
  ...(lastCheck && width >= 96
    ? [{ id: "last", label: "Last check", width: 34, align: "left" as const }]
    : []),
  { id: "status", label: "State", width: 8, align: "left" },
  { id: "created", label: "Since", width: 10, align: "left" },
];

export function EventAlertsPane({ focused, width, height }: PaneProps) {
  const [json, setJson] = usePluginConfigState<string>(EVENT_ALERTS_KEY, "[]");
  const { rules, error } = useMemo(() => readEventAlerts(json), [json]);
  const [selected, setSelected] = useState(0);
  const [sort, setSort] = useState({ id: "created", direction: "desc" as "asc" | "desc" });
  const sync = useCloudSyncStatus();
  const dialog = useDialog();
  const { openPluginCommandWorkflow } = usePluginAppActions();
  const items = useMemo(
    () =>
      [...rules].sort((a, b) => {
        const value = (rule: EventAlertRule) =>
          sort.id === "target"
            ? eventAlertTarget(rule)
            : sort.id === "created"
              ? rule.createdAt
              : sort.id === "kind"
                ? rule.kind
                : rule.status;
        return (
          String(value(a)).localeCompare(String(value(b))) * (sort.direction === "asc" ? 1 : -1)
        );
      }),
    [rules, sort],
  );
  const selectedRule = items[Math.min(selected, Math.max(0, items.length - 1))];
  // Research rules keep a dated observation in the Cloud; show its value and percentile.
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const hasResearch = rules.some((rule) => isResearchAlertKind(rule.kind));
  const stateLoader = useCallback(() => fetchAlertHistory(0), [session.requestKey]);
  const history = useAsyncResource(access.signedIn && hasResearch ? stateLoader : null);
  const states = useMemo(
    () => new Map((history.data?.states ?? []).map((state) => [state.ruleId, state])),
    [history.data],
  );
  const columns = columnsFor(width, hasResearch && !!history.data);
  const add = useCallback(
    () => openPluginCommandWorkflow("set-event-alert"),
    [openPluginCommandWorkflow],
  );
  const toggle = useCallback(
    (rule: EventAlertRule | undefined) => {
      if (!rule) return;
      setJson((current) => {
        const result = readEventAlerts(current);
        return result.error
          ? current
          : JSON.stringify(
              result.rules.map((entry) => (entry.id === rule.id ? toggleEventAlert(entry) : entry)),
            );
      });
    },
    [setJson],
  );
  const remove = useCallback(async () => {
    if (!selectedRule) return;
    const id = selectedRule.id;
    const confirmed = await dialog
      .prompt<boolean>({
        closeOnClickOutside: true,
        content: (context: PromptContext<boolean>) => (
          <ConfirmDialog
            {...context}
            title="Delete event alert?"
            body={[eventAlertTarget(selectedRule)]}
            confirmLabel="Delete"
          />
        ),
      })
      .catch(() => false);
    if (confirmed)
      setJson((current) => {
        const result = readEventAlerts(current);
        return result.error
          ? current
          : JSON.stringify(result.rules.filter((rule) => rule.id !== id));
      });
  }, [dialog, selectedRule, setJson]);
  const status =
    error ??
    sync.error ??
    (sync.phase === "disabled"
      ? "Cloud sync disabled"
      : sync.phase === "syncing"
        ? "Syncing alert rules"
        : sync.lastSyncAt
          ? `Synced ${relativeTime(Date.parse(sync.lastSyncAt))}`
          : "Waiting for Cloud sync");
  usePaneFooter(
    "event-alerts",
    () => ({
      info: [
        { id: "sync", parts: [{ text: status, tone: error || sync.error ? "warning" : "muted" }] },
      ],
      hints: [
        { id: "add", key: "a", label: "dd event", onPress: add, disabled: !!error },
        {
          id: "toggle",
          key: "p",
          label: selectedRule?.status === "paused" ? "resume" : "ause",
          onPress: () => toggle(selectedRule),
          disabled: !selectedRule,
        },
        {
          id: "delete",
          key: "d",
          label: "elete",
          onPress: () => void remove(),
          disabled: !selectedRule,
        },
      ],
    }),
    [status, error, selectedRule, add, toggle, remove],
  );
  const onKey = useCallback(
    (event: DataTableKeyEvent) => {
      if (isPlainKey(event, "a") && !error) add();
      else if (isPlainKey(event, "p")) toggle(selectedRule);
      else if (isPlainKey(event, "d")) void remove();
      else return false;
      event.preventDefault?.();
      return true;
    },
    [add, error, remove, selectedRule, toggle],
  );
  return (
    <DataTableView<EventAlertRule, DataTableColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      columns={columns}
      items={items}
      selection={{
        kind: "index",
        selectedIndex: Math.min(selected, Math.max(0, items.length - 1)),
        onChange: setSelected,
      }}
      getItemKey={(rule) => rule.id}
      onActivate={toggle}
      onRootKeyDown={onKey}
      sortColumnId={sort.id}
      sortDirection={sort.direction}
      onHeaderClick={(id) =>
        setSort((current) => ({
          id,
          direction: current.id === id && current.direction === "asc" ? "desc" : "asc",
        }))
      }
      renderCell={(rule, column, _index, row) => ({
        text:
          column.id === "kind"
            ? alertKindLabel(rule.kind)
            : column.id === "last"
              ? isResearchAlertKind(rule.kind)
                ? ruleStateText(states.get(rule.id))
                : ""
              : column.id === "target"
              ? eventAlertTarget(rule)
              : column.id === "status"
                ? rule.status === "active"
                  ? "Active"
                  : "Paused"
                : new Date(rule.createdAt).toISOString().slice(0, 10),
        color: row.selected
          ? colors.selectedText
          : rule.status === "paused"
            ? colors.textMuted
            : colors.text,
      })}
      emptyStateTitle={error ?? "No event alerts"}
      emptyContent={error ? undefined : (
        <Box paddingX={1} paddingY={1}>
          <EmptyState
            title="No event alerts"
            message="Follow filings, news, earnings, members, funds or market moves."
            actions={<Button label="Add event alert" compact onPress={add} />}
          />
        </Box>
      )}
    />
  );
}
