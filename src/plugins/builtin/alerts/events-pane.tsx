import { CATALYST_POLL_STATUS } from "./catalysts";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { useCallback, useMemo, useState } from "react";
import {
  Button,
  confirmDialog,
  DataTableView,
  PaneStatusBody,
  usePaneFooter,
  useTableLayoutWidth,
  type DataTableColumn,
} from "../../../components";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { useDialog } from "../../../ui/dialog";
import { useCloudSyncStatus } from "../../../sync/react";
import { usePluginAppActions, usePluginConfigState, usePluginState } from "../../runtime";
import {
  CALENDAR_ALERTS_KEY,
  EVENT_ALERTS_KEY,
  IV_LEVEL_ALERTS_KEY,
  eventAlertStoreKey,
  eventAlertTarget,
  readEventAlertStores,
  toggleEventAlert,
  updateEventAlerts,
  type EventAlertRule,
} from "./events";
import { ruleState, ruleTarget } from "./event-rows";
import { relativeTime } from "./format";
import { alertKindLabel, fetchAlertHistory, ruleStateText } from "./history";
import { isResearchAlertKind } from "./research-rules";
import { useAsyncResource } from "../../../public/react";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { rearmScheduledAlert } from "./scheduled";
import { checkScheduledEventAlertsNow } from "./scheduled-check";
import { checkIvLevelAlertsNow, IV_LEVEL_CHECKS_KEY, ivLevelCheckText, readIvLevelChecks, rearmIvLevelAlert } from "./iv-level";
import { alertTarget, alertViewHints, eventRuleSubject, useOpenAlertTarget } from "./targets";

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
  const tableLayoutWidth = useTableLayoutWidth(width);
  const [catalystStatus] = usePluginConfigState<string>(CATALYST_POLL_STATUS, "Catalyst alerts check every five minutes while the app is open");
  const [json, setJson] = usePluginConfigState<string>(EVENT_ALERTS_KEY, "[]");
  // IV levels and calendar events are kept in their own lists, which released versions never read.
  const [ivJson, setIvJson] = usePluginConfigState<string>(IV_LEVEL_ALERTS_KEY, "[]");
  const [calendarJson, setCalendarJson] = usePluginConfigState<string>(CALENDAR_ALERTS_KEY, "[]");
  const { rules, error } = useMemo(
    () => readEventAlertStores((key) => key === IV_LEVEL_ALERTS_KEY ? ivJson : key === CALENDAR_ALERTS_KEY ? calendarJson : json),
    [json, ivJson, calendarJson],
  );
  // Their readings stay on this device.
  const [savedChecks] = usePluginState<unknown>(IV_LEVEL_CHECKS_KEY, {});
  const checks = useMemo(() => readIvLevelChecks(savedChecks), [savedChecks]);
  /** Changes one rule in the list it is kept in, leaving what that list holds of kinds this version does not know. */
  const updateRules = useCallback(
    (rule: EventAlertRule, update: (rules: EventAlertRule[]) => EventAlertRule[]) => {
      const key = eventAlertStoreKey(rule);
      (key === IV_LEVEL_ALERTS_KEY ? setIvJson : key === CALENDAR_ALERTS_KEY ? setCalendarJson : setJson)((current) => updateEventAlerts(current, update));
    },
    [setJson, setIvJson, setCalendarJson],
  );
  const [selected, setSelected] = useState(0);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "created", direction: "desc" });
  const sync = useCloudSyncStatus();
  const dialog = useDialog();
  const { openPluginCommandWorkflow } = usePluginAppActions();
  const items = useMemo(
    () =>
      [...rules].sort((a, b) => {
        const value = (rule: EventAlertRule) =>
          sort.columnId === "target"
            ? ruleTarget(rule)
            : sort.columnId === "created"
              ? rule.createdAt
              : sort.columnId === "kind"
                ? rule.kind
                : rule.status;
        return (
          String(value(a)).localeCompare(String(value(b))) * (sort.direction === "asc" ? 1 : -1)
        );
      }),
    [rules, sort],
  );
  const selectedRule = items[Math.min(selected, Math.max(0, items.length - 1))];
  const now = Date.now();
  const selectedFired = !!selectedRule && ruleState(selectedRule, now) === "Alerted";
  const openTarget = useOpenAlertTarget();
  const selectedTarget = useMemo(() => selectedRule ? alertTarget(eventRuleSubject(selectedRule)) : null, [selectedRule]);
  // Research rules keep a dated observation in the Cloud; show its value and percentile.
  const access = usePlanAccess();
  const session = useResearchCloudSession();
  const hasResearch = rules.some((rule) => isResearchAlertKind(rule.kind) && rule.kind !== "iv_level");
  const stateLoader = useCallback(() => fetchAlertHistory(0), [session.requestKey]);
  const history = useAsyncResource(access.signedIn && hasResearch ? stateLoader : null);
  const states = useMemo(
    () => new Map((history.data?.states ?? []).map((state) => [state.ruleId, state])),
    [history.data],
  );
  // An IV level is read by this app, so its last reading needs no session.
  const columns = columnsFor(tableLayoutWidth, (hasResearch && !!history.data) || rules.some((rule) => rule.kind === "iv_level"));
  const add = useCallback(
    () => openPluginCommandWorkflow("set-event-alert"),
    [openPluginCommandWorkflow],
  );
  const toggle = useCallback(
    (rule: EventAlertRule | undefined) => {
      if (!rule) return;
      updateRules(rule, (rules) => rules.map((entry) => (entry.id === rule.id ? toggleEventAlert(entry) : entry)));
    },
    [updateRules],
  );
  // An earnings or macro alert that went off alerts again for the same event; an IV level watches its level again.
  const rearm = useCallback(
    (rule: EventAlertRule | undefined) => {
      if (!rule) return;
      const ivLevel = rule.kind === "iv_level";
      updateRules(rule, (rules) => rules.map((entry) => (entry.id === rule.id ? ivLevel ? rearmIvLevelAlert(entry) : rearmScheduledAlert(entry) : entry)));
      // Once the write has landed, so it alerts now rather than at the next 15-minute check.
      setTimeout(ivLevel ? checkIvLevelAlertsNow : checkScheduledEventAlertsNow, 1_000);
    },
    [updateRules],
  );
  const remove = useCallback(async () => {
    if (!selectedRule) return;
    const rule = selectedRule;
    const confirmed = await confirmDialog(dialog, {
      title: "Delete event alert?",
      body: [eventAlertTarget(rule)],
      confirmLabel: "Delete",
    });
    if (confirmed) updateRules(rule, (rules) => rules.filter((entry) => entry.id !== rule.id));
  }, [dialog, selectedRule, updateRules]);
  const status =
    error ??
    (selectedRule?.kind === "catalyst" ? catalystStatus : null) ??
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
        ...alertViewHints(selectedTarget, openTarget),
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
        ...(selectedFired
          ? [{ id: "rearm", key: "m", label: "re-arm", title: "Re-arm", onPress: () => rearm(selectedRule) }]
          : []),
      ],
    }),
    [status, error, selectedRule, selectedFired, selectedTarget, add, toggle, rearm, remove, openTarget],
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
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id))}
      renderCell={(rule, column, _index, row) => {
        // An IV level that could not be read says so on its own row: No data in State, the reason in Last check.
        const check = rule.kind === "iv_level" ? checks[rule.id] : undefined;
        const unread = rule.kind === "iv_level" && rule.status === "active" && !rule.triggeredAt && check?.value === null;
        const state = ruleState(rule, now);
        return {
          text:
            column.id === "kind"
              ? alertKindLabel(rule.kind)
              : column.id === "last"
                ? rule.kind === "iv_level"
                  ? ivLevelCheckText(rule, check)
                  : isResearchAlertKind(rule.kind)
                    ? ruleStateText(states.get(rule.id))
                    : ""
                : column.id === "target"
                ? ruleTarget(rule)
                : column.id === "status"
                  ? unread ? "No data" : state
                  : new Date(rule.createdAt).toISOString().slice(0, 10),
          color: row.selected
            ? colors.selectedText
            : unread && (column.id === "status" || column.id === "last")
              ? colors.negative
              : rule.status === "paused"
                ? colors.textMuted
                : colors.text,
        };
      }}
      emptyStateTitle={error ?? "No event alerts"}
      emptyContent={error ? undefined : (
        <PaneStatusBody
          empty
          emptyTitle="No event alerts"
          emptyMessage="Follow earnings and CPI or FOMC dates, filings, news, IV levels, members, funds or market moves."
          actions={<Button label="Add event alert" compact onPress={add} />}
        />
      )}
    />
  );
}
