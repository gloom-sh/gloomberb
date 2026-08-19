import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataTableView,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { colors } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import type { PaneProps } from "../../../types/plugin";
import { usePluginAppActions, usePluginConfigState } from "../../runtime";
import {
  deserializeAlerts,
  readAlertsStoreError,
  serializeAlerts,
} from "./alert-engine";
import { ALERTS_KEY } from "./constants";
import {
  conditionLabel,
  formatAlertDistance,
  formatAlertTargetPrice,
  formatCurrentPrice,
  formatQuoteChecked,
  relativeTime,
} from "./format";
import type { AlertRule } from "./types";

type AlertColumnId =
  | "status"
  | "symbol"
  | "current"
  | "target"
  | "away"
  | "condition"
  | "quote"
  | "triggered"
  | "rearm";

type AlertColumn = DataTableColumn & { id: AlertColumnId };

const ALERT_COLUMNS: AlertColumn[] = [
  { id: "status", label: "State", width: 6, align: "left" },
  { id: "symbol", label: "Symbol", width: 7, align: "left" },
  { id: "current", label: "Current", width: 9, align: "right" },
  { id: "target", label: "Target", width: 9, align: "right" },
  { id: "away", label: "Away", width: 8, align: "right" },
  { id: "condition", label: "Trigger", width: 7, align: "left" },
  { id: "quote", label: "Quote", width: 8, align: "left" },
  { id: "triggered", label: "Alerted", width: 8, align: "left" },
  { id: "rearm", label: "", width: 6, align: "left" },
];

const ALERT_TABLE_CONTENT_WIDTH = ALERT_COLUMNS.reduce(
  (sum, column) => sum + column.width + 1,
  2,
);

export function AlertsPane({ focused, width, height, close }: PaneProps) {
  const [alertsJson, setAlertsJson] = usePluginConfigState<string>(ALERTS_KEY, "[]");
  const { openPluginCommandWorkflow } = usePluginAppActions();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const showHorizontalScrollbar = ALERT_TABLE_CONTENT_WIDTH > width;
  const storeError = useMemo(() => readAlertsStoreError(alertsJson), [alertsJson]);

  const { alerts, rows, quoteError } = useMemo(() => {
    const parsed = deserializeAlerts(alertsJson);
    const activeAlerts = parsed.filter((a) => a.status === "active");
    const triggeredAlerts = parsed
      .filter((a) => a.status === "triggered")
      .sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0));

    return {
      alerts: parsed,
      rows: [...activeAlerts, ...triggeredAlerts],
      quoteError: parsed.find((alert) => alert.lastCheckError)?.lastCheckError ?? null,
    };
  }, [alertsJson]);

  const savePaneAlerts = useCallback((next: AlertRule[] | ((current: AlertRule[]) => AlertRule[])) => {
    setAlertsJson((currentJson) => {
      const current = deserializeAlerts(currentJson);
      const resolved = typeof next === "function" ? next(current) : next;
      return serializeAlerts(resolved);
    });
  }, [setAlertsJson]);

  const deleteAlert = useCallback((id: string) => {
    savePaneAlerts(alerts.filter((a) => a.id !== id));
    setSelectedIdx((prev) => Math.max(0, Math.min(prev, rows.length - 2)));
  }, [alerts, rows.length, savePaneAlerts]);

  const rearmAlert = useCallback((id: string) => {
    savePaneAlerts(
      alerts.map((a) =>
        a.id === id ? {
          ...a,
          status: "active" as const,
          triggeredAt: undefined,
          lastCheckError: undefined,
        } : a,
      ),
    );
  }, [alerts, savePaneAlerts]);

  const startAddAlert = useCallback(() => {
    openPluginCommandWorkflow("set-alert");
  }, [openPluginCommandWorkflow]);

  const deleteSelectedAlert = useCallback(() => {
    const selected = rows[selectedIdx];
    if (selected) deleteAlert(selected.id);
  }, [deleteAlert, rows, selectedIdx]);

  // Quotes come from the plugin's single background poll, which writes into the
  // same persisted store, so the pane never fetches on its own.

  usePaneFooter("alerts", () => ({
    info: storeError
      ? [{ id: "store-error", parts: [{ text: storeError, tone: "warning" as const }] }]
      : quoteError
        ? [{ id: "quote-error", parts: [{ text: quoteError, tone: "warning" as const }] }]
        : [],
    hints: [
      { id: "add", key: "a", label: "dd alert", onPress: startAddAlert },
      {
        id: "delete",
        key: "d",
        label: "elete",
        onPress: deleteSelectedAlert,
        disabled: rows.length === 0,
      },
    ],
  }), [
    deleteSelectedAlert,
    quoteError,
    rows.length,
    startAddAlert,
    storeError,
  ]);

  useEffect(() => {
    setSelectedIdx((prev) => (rows.length === 0 ? 0 : Math.min(prev, rows.length - 1)));
  }, [rows.length]);

  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (event.name === "d") {
      event.preventDefault?.();
      deleteSelectedAlert();
      return true;
    }
    if (event.name === "a" || event.name === "n") {
      event.preventDefault?.();
      startAddAlert();
      return true;
    }
    if (event.name === "escape") {
      event.preventDefault?.();
      close?.();
      return true;
    }
    return false;
  }, [close, deleteSelectedAlert, startAddAlert]);

  const renderCell = useCallback((
    alert: AlertRule,
    column: AlertColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    const actionMouseDown = (handler: () => void) => (
      event: { preventDefault?: () => void; stopPropagation?: () => void },
    ) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      handler();
    };

    switch (column.id) {
      case "status":
        return {
          text: alert.status === "triggered" ? "Trig" : "Active",
          color: selectedColor ?? (alert.status === "triggered" ? colors.positive : colors.textDim),
          attributes: alert.status === "triggered" ? TextAttributes.BOLD : TextAttributes.NONE,
        };
      case "symbol":
        return {
          text: alert.symbol,
          color: selectedColor ?? colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "current":
        return {
          text: formatCurrentPrice(alert, column.width),
          color: selectedColor ?? (alert.lastCheckError ? colors.negative : colors.text),
        };
      case "target":
        return { text: formatAlertTargetPrice(alert, column.width), color: selectedColor };
      case "away":
        return {
          text: formatAlertDistance(alert),
          color: selectedColor ?? colors.textDim,
        };
      case "condition":
        return {
          text: conditionLabel(alert.condition),
          color: selectedColor,
        };
      case "quote":
        return {
          text: formatQuoteChecked(alert),
          color: selectedColor ?? colors.textDim,
        };
      case "triggered":
        return {
          text: alert.triggeredAt ? relativeTime(alert.triggeredAt) : "-",
          color: selectedColor ?? colors.textDim,
        };
      case "rearm":
        return alert.status === "triggered"
          ? {
              text: "Re-arm",
              color: selectedColor ?? colors.textBright,
              onMouseDown: actionMouseDown(() => rearmAlert(alert.id)),
            }
          : { text: "-", color: selectedColor ?? colors.textDim };
    }
  }, [rearmAlert]);

  return (
    <DataTableView<AlertRule, AlertColumn>
      focused={focused}
      selection={{
        kind: "index",
        selectedIndex: selectedIdx,
        onChange: (index) => setSelectedIdx(index),
      }}
      onRootKeyDown={handleTableKeyDown}
      rootWidth={width}
      rootHeight={height}
      rootBackgroundColor={colors.bg}
      columns={ALERT_COLUMNS}
      items={rows}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      getItemKey={(alert) => alert.id}
      onActivate={(alert) => {
        if (alert.status === "triggered") rearmAlert(alert.id);
      }}
      renderCell={renderCell}
      emptyStateTitle={storeError ? "Saved alerts could not be read." : "No alerts"}
      emptyStateHint={storeError ?? "Press a to add a price alert."}
      showHorizontalScrollbar={showHorizontalScrollbar}
    />
  );
}
