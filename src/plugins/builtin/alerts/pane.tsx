import { METRIC_ALERTS_KEY, RELATIVE_ALERTS_KEY, closeBasis, isRelativeMetric, metricName, metricReadingText } from "./metric-model";
import { metricAvailabilityError } from "./metric-data";
import { relativeAlertText } from "./metric-command";
import { levelAlertStoreKey, readLevelAlertStores } from "./storage";
import { Box, type ScrollBoxRenderable } from "../../../ui";
import { Button, DetailScrollBody, KeyValueRow, Notice, PaneStatusBody, PaneFooterScope, usePaneTabs } from "../../../components";
import { usePluginPaneState } from "../../runtime";
import { EventAlertsPane } from "./events-pane";
import { AlertHistoryPane } from "./history-pane";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import {
  confirmDialog,
  DataTableStackView,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { TextFieldDialog } from "../../../components/pane-settings-dialog/field-dialogs";
import { colors } from "../../../theme/colors";
import { isPlainKey } from "../../../utils/keyboard";
import { TextAttributes } from "../../../ui";
import { useDialog, type AlertContext } from "../../../ui/dialog";
import type { PaneProps } from "../../../types/plugin";
import { usePluginAppActions, usePluginConfigState } from "../../runtime";
import {
  deserializeAlerts,
  editAlert,
  formatAlertDescription,
  rearmAlert as rebuildAlert,
  readAlertsStoreError,
  serializeAlerts,
} from "./alert-engine";
import { parseAlertCommandValues } from "./command";
import { ALERT_TABS, ALERTS_KEY } from "./constants";
import {
  conditionLabel,
  formatAlertDistance,
  formatAlertTargetPrice,
  formatCurrentPrice,
  formatQuoteChecked,
  relativeTime,
} from "./format";
import type { AlertRule } from "./types";
import { useQuoteEntries } from "../../../market-data/hooks";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { alertInstrument, streamedAlertQuote, syncAlertQuoteStream } from "./live";
import { quoteAlertFields } from "./quotes";
import { clearPriceAlertFocus, getPriceAlertFocus, subscribePriceAlertFocus } from "./focus";
import { alertTarget, alertViewHints, priceRuleSubject, useOpenAlertTarget } from "./targets";

type AlertColumnId =
  | "status"
  | "symbol"
  | "metric"
  | "current"
  | "target"
  | "away"
  | "condition"
  | "quote"
  | "triggered";

type AlertColumn = DataTableColumn & { id: AlertColumnId };

const ALERT_COLUMNS: AlertColumn[] = [
  { id: "status", label: "State", width: 9, align: "left" },
  { id: "symbol", label: "Symbol", width: 7, align: "left" },
  { id: "metric", label: "Measure", width: 14, align: "left" },
  { id: "current", label: "Current", width: 8, align: "right" },
  { id: "target", label: "Target", width: 11, align: "right" },
  { id: "away", label: "Away", width: 8, align: "right" },
  { id: "condition", label: "Trigger", width: 12, align: "left" },
  { id: "quote", label: "Quote", width: 14, align: "left" },
  { id: "triggered", label: "Alerted", width: 8, align: "left" },
];

const DETAIL_ROW = { labelWidth: 10, emphasis: false } as const;

/** "AAPL above 400.00": the rule, which titles its detail. */
function alertTitle(alert: AlertRule): string {
  if (alert.metric) return formatAlertDescription(alert);
  return `${alert.symbol} ${conditionLabel(alert.condition).toLowerCase()} ${formatAlertTargetPrice(alert)}`;
}

/**
 * One price alert in full: why it has no quote, when there is a reason, then
 * the figures its row shortens. The title names the rule.
 */
function AlertDetail({ alert, scrollRef }: { alert: AlertRule; scrollRef: RefObject<ScrollBoxRenderable | null> }) {
  const reason = alert.lastCheckError
    ? alert.lastCheckError.includes(alert.symbol) ? alert.lastCheckError : `${alert.symbol}: ${alert.lastCheckError}`
    : null;
  const basis = alert.metric ? closeBasis(alert.metric) : null;
  return (
    <DetailScrollBody ref={scrollRef} resetScrollKey={alert.id}>
      <Box flexDirection="column">
        {reason ? <Box paddingBottom={1}><Notice tone="warning">{reason}</Notice></Box> : null}
        <KeyValueRow {...DETAIL_ROW} label="State" value={alert.status === "triggered" ? "Triggered" : "Active"} tone={alert.status === "triggered" ? "positive" : "muted"} />
        {/* With no quote the reason above says why; the price and its distance wait for one. */}
        {basis ? <KeyValueRow {...DETAIL_ROW} label="Close date" value={alert.lastDailyClose ?? `Awaiting ${basis}`} /> : null}
        {reason ? null : <KeyValueRow {...DETAIL_ROW} label="Current" value={formatCurrentPrice(alert, 24)} />}
        {/* The two readings that place the quadrant, as RRG states them. */}
        {!reason && alert.metric?.kind === "rrg" && alert.lastCheckedPrice != null && alert.lastCheckedTarget != null ? <>
          <KeyValueRow {...DETAIL_ROW} label="Strength" value={alert.lastCheckedPrice.toFixed(2)} />
          <KeyValueRow {...DETAIL_ROW} label="Momentum" value={alert.lastCheckedTarget.toFixed(2)} />
        </> : null}
        {reason ? null : <KeyValueRow {...DETAIL_ROW} label="Away" value={formatAlertDistance(alert)} />}
        {reason
          ? alert.lastCheckedAt ? <KeyValueRow {...DETAIL_ROW} label="Checked" value={relativeTime(alert.lastCheckedAt)} tone="muted" /> : null
          : <KeyValueRow {...DETAIL_ROW} label="Quote" value={formatQuoteChecked(alert)} tone="muted" />}
        {alert.triggeredAt ? <KeyValueRow {...DETAIL_ROW} label="Alerted" value={relativeTime(alert.triggeredAt)} /> : null}
        <KeyValueRow {...DETAIL_ROW} label="Armed" value={relativeTime(alert.armedAt ?? alert.createdAt)} tone="muted" />
      </Box>
    </DetailScrollBody>
  );
}

export function AlertsPane(props: PaneProps) {
  const [tab, setTab] = usePluginPaneState<string>("tab", "prices");
  // A missed price alert opened from the Unread list selects its rule on Prices.
  useEffect(() => {
    const showPrices = () => {
      if (getPriceAlertFocus()) setTab("prices");
    };
    showPrices();
    return subscribePriceAlertFocus(showPrices);
  }, [setTab]);
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: ALERT_TABS,
    activeValue: tab,
    onSelect: setTab,
    focused: props.focused,
    dense: true,
  });
  return (
    <Box flexDirection="column" width={props.width} height={props.height}>
      {tabStrip}
      <PaneFooterScope active>
        {tab === "events" ? (
          <EventAlertsPane {...props} height={Math.max(1, props.height - tabRows)} />
        ) : tab === "history" ? (
          <AlertHistoryPane {...props} height={Math.max(1, props.height - tabRows)} />
        ) : (
          <PriceAlertsPane {...props} height={Math.max(1, props.height - tabRows)} />
        )}
      </PaneFooterScope>
    </Box>
  );
}

function PriceAlertsPane({ focused, width, height }: PaneProps) {
  const [alertsJson, setAlertsJson] = usePluginConfigState<unknown>(ALERTS_KEY, "[]");
  const [metricsJson, setMetricsJson] = usePluginConfigState<unknown>(METRIC_ALERTS_KEY, "[]");
  const [relativeJson, setRelativeJson] = usePluginConfigState<unknown>(RELATIVE_ALERTS_KEY, "[]");
  const { openPluginCommandWorkflow, notify } = usePluginAppActions();
  const dialog = useDialog();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [detailOpen, setDetailOpen] = useState(false);
  // The alert the open detail shows, by id, so it never becomes whichever alert takes its row.
  const detailAlertId = useRef<string | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  // Keep the rule and daily-close basis visible in a narrow pane; the detail keeps all figures.
  const columns = width < 106 ? ALERT_COLUMNS.filter(column => column.id !== "away" && column.id !== "triggered") : ALERT_COLUMNS;
  const showHorizontalScrollbar = columns.reduce((sum, column) => sum + column.width + 1, 2) > width;
  const stores = useMemo(() => readLevelAlertStores(key => key === ALERTS_KEY ? alertsJson : key === METRIC_ALERTS_KEY ? metricsJson : relativeJson),
    [alertsJson, metricsJson, relativeJson]);
  const storeError = stores.error;

  const { alerts, rows } = useMemo(() => {
    const parsed = stores.alerts;
    const activeAlerts = parsed.filter((a) => a.status === "active");
    const triggeredAlerts = parsed
      .filter((a) => a.status === "triggered")
      .sort((a, b) => (b.triggeredAt ?? 0) - (a.triggeredAt ?? 0));

    return {
      alerts: parsed,
      rows: [...activeAlerts, ...triggeredAlerts],
    };
  }, [stores]);

  const focusedAlertId = useSyncExternalStore(subscribePriceAlertFocus, getPriceAlertFocus, getPriceAlertFocus);
  useEffect(() => {
    if (!focusedAlertId) return;
    // A rule deleted since it fired leaves the selection where it was.
    const index = rows.findIndex((row) => row.id === focusedAlertId);
    if (index >= 0) setSelectedIdx(index);
    clearPriceAlertFocus();
  }, [focusedAlertId, rows]);

  // The store keeps the last checked price at a coarse cadence; while a
  // symbol streams the table shows its live price instead.
  const liveInstruments = useMemo(() => {
    const unique = new Map(rows
      .filter((alert) => !alert.metric && alert.status === "active")
      .map((alert) => [buildQuoteKey(alertInstrument(alert)), alertInstrument(alert)] as const));
    return [...unique.values()];
  }, [rows]);
  const liveEntries = useQuoteEntries(liveInstruments);
  // Re-arm, edit and delete write the store from here; the stream follows the
  // new symbol set now rather than at the next check.
  const liveSymbolsKey = liveInstruments.map((instrument) => buildQuoteKey(instrument)).sort().join("\u001f");
  useEffect(() => {
    syncAlertQuoteStream();
  }, [liveSymbolsKey]);
  const displayRows = useMemo(() => rows.map((alert) => {
    if (alert.metric) {
      const error = metricAvailabilityError(alert) ?? alert.lastCheckError;
      return error ? { ...alert, lastCheckError: error } : alert;
    }
    if (alert.status !== "active") return alert;
    const quote = streamedAlertQuote(resolveEntryData(liveEntries.get(buildQuoteKey(alertInstrument(alert)))));
    return quote ? { ...alert, ...quoteAlertFields(quote, quote.receivedAt) } : alert;
  }), [liveEntries, rows]);

  const savePaneAlerts = useCallback((id: string, next: (current: AlertRule[]) => AlertRule[]): string | null => {
    const found = alerts.find(alert => alert.id === id);
    const key = found ? levelAlertStoreKey(found) : ALERTS_KEY;
    if (stores.errors[key]) return stores.errors[key];
    let error: string | null = null;
    const setJson = key === METRIC_ALERTS_KEY ? setMetricsJson : key === RELATIVE_ALERTS_KEY ? setRelativeJson : setAlertsJson;
    setJson((currentJson: unknown) => {
      error = readAlertsStoreError(currentJson);
      return error ? currentJson : serializeAlerts(next(deserializeAlerts(currentJson)));
    });
    return error;
  }, [alerts, setAlertsJson, setMetricsJson, setRelativeJson, stores]);

  const deleteAlert = useCallback(async (id: string) => {
    const alert = alerts.find((a) => a.id === id);
    if (!alert) return;
    const confirmed = await confirmDialog(dialog, {
      title: "Delete alert?",
      body: [`${formatAlertDescription(alert)} will no longer be watched.`],
      confirmLabel: "Delete",
    });
    if (!confirmed) return;
    const error = savePaneAlerts(id, (current) => current.filter((a) => a.id !== id));
    if (error) {
      notify({ body: error, type: "error" });
      return;
    }
    setSelectedIdx((prev) => Math.max(0, Math.min(prev, rows.length - 2)));
  }, [alerts, dialog, notify, rows.length, savePaneAlerts]);

  const rearmAlert = useCallback((id: string) => {
    const error = savePaneAlerts(id,
      (current) => current.map((a) => (a.id === id ? rebuildAlert(a) : a)),
    );
    if (error) notify({ body: error, type: "error" });
  }, [notify, savePaneAlerts]);

  const startAddAlert = useCallback(() => {
    openPluginCommandWorkflow("set-alert");
  }, [openPluginCommandWorkflow]);

  const deleteSelectedAlert = useCallback(() => {
    const selected = rows[selectedIdx];
    if (selected) void deleteAlert(selected.id);
  }, [deleteAlert, rows, selectedIdx]);

  const selectedRule = rows[selectedIdx];
  // A quote one alert could not get is said on its row (Current and Quote),
  // and in full in its detail.
  const selectedShown = displayRows[selectedIdx];
  const selectedTarget = useMemo(() => selectedRule ? alertTarget(priceRuleSubject(selectedRule)) : null, [selectedRule]);
  const openTarget = useOpenAlertTarget();

  const rearmSelectedAlert = useCallback(() => {
    const selected = rows[selectedIdx];
    if (selected?.status === "triggered") rearmAlert(selected.id);
  }, [rearmAlert, rows, selectedIdx]);

  const editSelectedAlert = useCallback(() => {
    const selected = rows[selectedIdx];
    if (!selected) return;
    void dialog.alert({
      closeOnClickOutside: true,
      content: (context: AlertContext) => (
        <TextFieldDialog
          {...context}
          field={{
            type: "text",
            key: "alert",
            label: "Edit alert",
            description: "SYMBOL above|below|crosses PRICE",
            placeholder: "AAPL above 200",
          }}
          currentValue={relativeAlertText(selected) ?? (selected.metric ? formatAlertDescription(selected).replace(" (TTM)", "").replace(" · on daily close", "") : `${selected.symbol} ${selected.condition} ${selected.targetPrice}`)}
          onApply={async (value) => {
            let parsed = parseAlertCommandValues({ shortcut: value });
            if (!parsed) throw new Error("Use SYMBOL above|below|crosses PRICE.");
            if (!!parsed.metric !== !!selected.metric) throw new Error("Add a new alert to change between price and a valuation or technical measure.");
            if (selected.metric && isRelativeMetric(selected.metric)) {
              // The benchmark listing was confirmed when the alert was added; a different pair is a new alert.
              if (parsed.metric?.kind !== selected.metric.kind || parsed.symbol !== selected.symbol || parsed.metric.benchmark !== selected.metric.benchmark) {
                throw new Error("Add a new alert to compare other listings.");
              }
              parsed = { ...parsed, metric: { ...parsed.metric, benchmarkExchange: selected.metric.benchmarkExchange } };
            }
            const error = savePaneAlerts(selected.id, (current) => current.map((alert) => (
              alert.id === selected.id
                ? { ...editAlert(alert, parsed.symbol, parsed.condition, parsed.price), ...(parsed.metric ? { metric: parsed.metric } : {}) }
                : alert
            )));
            if (error) throw new Error(error);
          }}
        />
      ),
    });
  }, [dialog, rows, savePaneAlerts, selectedIdx]);

  // Quotes come from the plugin's single background poll, which writes into the
  // same persisted store, so the pane never fetches on its own.

  // A quote one alert could not get shows on that alert's row (Current and Quote), not here.
  usePaneFooter("alerts", () => ({
    info: storeError
      ? [{ id: "store-error", parts: [{ text: storeError, tone: "warning" as const }] }]
      : [],
    hints: [
      { id: "add", key: "a", label: "dd alert", onPress: startAddAlert },
      ...alertViewHints(selectedTarget, openTarget),
      {
        id: "edit",
        key: "e",
        label: "dit",
        onPress: editSelectedAlert,
        disabled: rows.length === 0,
      },
      {
        id: "delete",
        key: "d",
        label: "elete",
        onPress: deleteSelectedAlert,
        disabled: rows.length === 0,
      },
      ...(rows[selectedIdx]?.status === "triggered"
        ? [{ id: "rearm", key: "m", label: "re-arm", title: "Re-arm", onPress: rearmSelectedAlert }]
        : []),
    ],
  }), [
    deleteSelectedAlert,
    editSelectedAlert,
    rearmSelectedAlert,
    selectedTarget,
    openTarget,
    rows,
    selectedIdx,
    rows.length,
    startAddAlert,
    storeError,
  ]);

  useEffect(() => {
    setSelectedIdx((prev) => (rows.length === 0 ? 0 : Math.min(prev, rows.length - 1)));
  }, [rows.length]);

  // While the detail is open, a change to the list keeps it on its alert: it follows the alert to its new row (re-armed
  // or triggered, it changes group) and goes back to the list once the alert is deleted, from here or elsewhere.
  // Declared before the effect below, so a delete is checked against the alert shown, not the row that takes its place.
  useEffect(() => {
    if (!detailOpen) return;
    const index = rows.findIndex((row) => row.id === detailAlertId.current);
    if (index < 0) setDetailOpen(false);
    else setSelectedIdx(index);
  }, [detailOpen, rows]);
  // A new selection while it is open (an alert focused from Unread) is the alert it shows from then on.
  useEffect(() => {
    if (detailOpen) detailAlertId.current = rows[selectedIdx]?.id ?? null;
  }, [detailOpen, selectedIdx]);

  // The footer hints bind a, e, d and m; `n` is a second key for adding.
  const handleTableKeyDown = useCallback((event: DataTableKeyEvent) => {
    if (!isPlainKey(event, "n")) return false;
    startAddAlert();
    return true;
  }, [startAddAlert]);

  const renderCell = useCallback((
    alert: AlertRule,
    column: AlertColumn,
  ): DataTableCell => {
    switch (column.id) {
      case "status":
        return {
          text: alert.status === "triggered" ? "Triggered" : alert.lastCheckError && alert.metric ? "Blocked" : "Active",
          color: alert.status === "triggered" ? colors.positive : colors.textDim,
          attributes: alert.status === "triggered" ? TextAttributes.BOLD : TextAttributes.NONE,
        };
      case "symbol":
        return {
          text: alert.symbol,
          color: colors.textBright,
          attributes: TextAttributes.BOLD,
        };
      case "metric":
        return { text: alert.metric ? metricName(alert.metric) : "Price" };
      case "current":
        return {
          text: formatCurrentPrice(alert, column.width),
          // The quadrant word exports with the readings that place it.
          ...(alert.metric?.kind === "rrg" && !alert.lastCheckError && alert.lastCheckedPrice != null && alert.lastCheckedTarget != null
            ? { value: metricReadingText(alert.metric, { value: alert.lastCheckedPrice, target: alert.lastCheckedTarget }) } : {}),
          color: alert.lastCheckError ? colors.negative : colors.text,
        };
      case "target":
        return { text: formatAlertTargetPrice(alert, column.width) };
      case "away":
        return {
          text: formatAlertDistance(alert),
          color: colors.textDim,
        };
      case "condition":
        return { text: alert.metric?.kind === "ma_cross" ? `Cross ${alert.metric.direction}` : alert.metric?.kind === "rrg" ? "Enters" : conditionLabel(alert.condition) };
      case "quote":
        return {
          text: formatQuoteChecked(alert),
          // A settled close exports as its session date.
          ...(alert.metric && closeBasis(alert.metric) && alert.lastDailyClose && !alert.lastCheckError ? { value: alert.lastDailyClose } : {}),
          color: alert.lastCheckError ? colors.negative : colors.textDim,
        };
      case "triggered":
        return {
          text: alert.triggeredAt ? relativeTime(alert.triggeredAt) : "-",
          color: colors.textDim,
        };
    }
  }, []);

  return (
    <DataTableStackView<AlertRule, AlertColumn>
      focused={focused}
      detailOpen={detailOpen && !!selectedShown}
      onBack={() => setDetailOpen(false)}
      detailTitle={selectedShown ? alertTitle(selectedShown) : undefined}
      detailContent={selectedShown ? <AlertDetail alert={selectedShown} scrollRef={detailScrollRef} /> : null}
      detailScrollRef={detailScrollRef}
      selection={{
        kind: "index",
        selectedIndex: selectedIdx,
        onChange: (index) => setSelectedIdx(index),
      }}
      onRootKeyDown={handleTableKeyDown}
      rootWidth={width}
      rootHeight={height}
      rootBackgroundColor={colors.bg}
      columns={columns}
      items={displayRows}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(alert) => alert.id}
      // Enter opens the alert; `m` re-arms a triggered one.
      onActivate={(alert) => {
        detailAlertId.current = alert.id;
        setDetailOpen(true);
      }}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      status={displayRows.length === 0 && storeError ? { error: storeError, subject: "price alerts" } : undefined}
      emptyStateTitle="No alerts"
      emptyContent={
        <PaneStatusBody empty emptyTitle="No alerts" actions={<Button label="Add alert" compact onPress={startAddAlert} />} />
      }
      showHorizontalScrollbar={showHorizontalScrollbar}
    />
  );
}
