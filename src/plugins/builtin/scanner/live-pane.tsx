import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LiveScanCondition, LiveScanMatch, LiveScanPayload } from "../../../api-client/live-scan";
import {
  Button,
  confirmDialog,
  DataTableView,
  PageStackView,
  QueryBar,
  TextField,
  useFieldRing,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
} from "../../../components";
import { withCompanyLogo } from "../../../components/company-logo";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { getTableWidth } from "../../../components/ui/table-layout";
import { useInputCapture, useShortcut } from "../../../public/react";
import { usePaneVisible } from "../../../state/app/activity";
import { useAppSelector, usePaneInstanceId, usePaneStateValue } from "../../../state/app/context";
import { colors, priceColor } from "../../../theme/colors";
import { TICKER_RESEARCH_PANE_ID } from "../../../types/config";
import type { PaneProps } from "../../../types/plugin";
import { Box, TextAttributes, useUiCapabilities } from "../../../ui";
import { useDialog, useDialogState } from "../../../ui/dialog";
import { publicTickerKey } from "../../../utils/exchanges";
import { formatCompact, formatPercentRaw } from "../../../utils/format";
import { logFailure } from "../../../utils/log-failure";
import { usePluginAppActions, usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { usePluginRenderContext } from "../../runtime/context";
import { recordFiredAlertFor } from "../alerts/fired-log";
import { useScannerStatusFooter } from "./feed";
import { formatHiloPrice } from "./hilo-model";
import { LiveConditionEditor } from "./live-condition-editor";
import { useLiveScanFeed } from "./live-feed";
import {
  conditionColumnLabel,
  conditionText,
  conditionUnit,
  DEFAULT_LIVE_SCAN,
  floorValue,
  formatMultiple,
  formatScanTime,
  LIVE_SCAN_MAX_CONDITIONS,
  LIVE_SCAN_MAX_SAVED,
  liveScanKey,
  matchValue,
  MIN_CAP_OPTIONS,
  MIN_PRICE_OPTIONS,
  MIN_VOLUME_OPTIONS,
  parseFloorValue,
  parseUniverseValue,
  readLiveScan,
  readSavedLiveScans,
  toWireScan,
  universeLabel,
  universeOptions,
  universeValue,
  type LiveScan,
  type SavedLiveScan,
} from "./live-model";
import {
  liveScanAlertText,
  liveScanFiredAlert,
  liveScanRowNote,
  LIVE_SCAN_HISTORY_LIMIT,
  trackLiveScan,
  type LiveScanRowNote,
  type LiveScanTrack,
} from "./live-track";

type Tab = "matches" | "conditions" | "saved";
const TABS: Array<{ value: Tab; label: string }> = [
  { value: "matches", label: "Matches" },
  { value: "conditions", label: "Conditions" },
  { value: "saved", label: "Saved" },
];

interface MatchSort {
  column: string | null;
  direction: "asc" | "desc";
}
const RANKED: MatchSort = { column: null, direction: "desc" };

/** Columns beyond the scan's own figures, in the order they are given room. */
const OPTIONAL_COLUMNS: DataTableColumn[] = [
  { id: "status", label: "STATUS", width: 13, align: "left" },
  { id: "volume", label: "VOLUME", width: 8, align: "right" },
  { id: "rvol", label: "RVOL", width: 6, align: "right" },
  { id: "vwap", label: "VS VWAP", width: 8, align: "right" },
  { id: "gap", label: "GAP", width: 7, align: "right" },
];
const DISPLAY_ORDER = ["symbol", "name", "price", "change", "conditions", "rvol", "volume", "vwap", "gap", "status"];

/**
 * Symbol, name, price and change, then one column per condition with the
 * figure it matched on, then context as the width allows: a column is added
 * only when it fits whole, the row's status first.
 */
function liveScanColumns(width: number, conditions: readonly LiveScanCondition[]): DataTableColumn[] {
  const own = conditions.map((condition, index): DataTableColumn => {
    const label = conditionColumnLabel(condition);
    return { id: `c:${index}`, label, width: Math.max(8, label.length), align: "right" };
  });
  const repeats = new Set(conditions.flatMap((condition) => (
    condition.kind === "gap" ? ["gap"] : condition.kind === "volume_spike" && condition.window === "day" ? ["rvol"] : []
  )));
  const base: DataTableColumn[] = [
    { id: "symbol", label: "SYMBOL", width: 7, align: "left" },
    { id: "name", label: "NAME", width: 14, flexGrow: 1, align: "left" },
    { id: "price", label: "PRICE", width: 9, align: "right" },
    { id: "change", label: "CHG%", width: 8, align: "right" },
  ];
  const order = (columns: DataTableColumn[]) => [...columns].sort((a, b) => (
    DISPLAY_ORDER.indexOf(a.id.startsWith("c:") ? "conditions" : a.id) - DISPLAY_ORDER.indexOf(b.id.startsWith("c:") ? "conditions" : b.id)
  ));
  let columns = order([...base, ...own]);
  for (const column of OPTIONAL_COLUMNS) {
    if (repeats.has(column.id)) continue;
    const next = order([...columns, column]);
    if (getTableWidth(next) > width) break;
    columns = next;
  }
  return columns;
}

function noteText(note: LiveScanRowNote | null): string {
  if (!note) return "";
  if (note.kind === "new") return "new";
  return `${note.kind} ${formatScanTime(note.at).slice(0, 5)}`;
}

function numberCell(value: number | null, format: (value: number) => string, color?: string): DataTableCell {
  return value == null ? { text: "--", color: colors.textDim } : { text: format(value), value, ...(color ? { color } : {}) };
}

const signColor = (value: number | null) => (value == null ? undefined : priceColor(Math.abs(value) < 0.005 ? 0 : value, colors));

function sortValue(match: LiveScanMatch, column: string, note: LiveScanRowNote | null): number | string | null {
  if (column.startsWith("c:")) return matchValue(match, Number(column.slice(2)));
  switch (column) {
    case "symbol":
      return match.symbol;
    case "name":
      return match.name ?? match.symbol;
    case "price":
      return match.price;
    case "change":
      return match.changePercent;
    case "volume":
      return match.volume;
    case "rvol":
      return match.relativeVolume;
    case "vwap":
      return match.vwapPercent;
    case "gap":
      return match.gapPercent;
    case "status":
      return note ? (note.kind === "new" ? Number.MAX_SAFE_INTEGER : note.at) : null;
    default:
      return null;
  }
}

/** The matches in the column's order, missing figures last; Gloom Cloud's ranking with no column. */
function sortMatches(
  matches: readonly LiveScanMatch[],
  sort: MatchSort,
  noteOf: (match: LiveScanMatch) => LiveScanRowNote | null,
): LiveScanMatch[] {
  const column = sort.column;
  if (!column) return [...matches];
  const sign = sort.direction === "asc" ? 1 : -1;
  return matches
    .map((match, index) => ({ match, index, value: sortValue(match, column, noteOf(match)) }))
    .sort((a, b) => {
      if (a.value == null || b.value == null) return a.value == null ? (b.value == null ? a.index - b.index : 1) : -1;
      const order = typeof a.value === "string" || typeof b.value === "string"
        ? String(a.value).localeCompare(String(b.value))
        : a.value - b.value;
      return order === 0 ? a.index - b.index : sign * order;
    })
    .map(({ match }) => match);
}

function emptyState(payload: LiveScanPayload | null): { title: string; hint?: string } {
  if (payload?.status === "starting") return { title: "The scanner is starting.", hint: "Matches appear within a minute." };
  if (payload?.status === "closed") return { title: "Nothing matched at the close.", hint: "The scan runs again at the open." };
  return { title: "Nothing matches right now." };
}

function warmingNotice(payload: LiveScanPayload | null): string | null {
  const windows = payload?.status === "live" || payload?.status === "degraded" ? payload.warmingWindows : [];
  if (!windows?.length) return null;
  const list = windows.map((window) => `${window} min`).join(", ");
  return `The scanner started recently: conditions over ${list} match nothing until that much of the session has been watched.`;
}

function SaveScanForm({
  name,
  onName,
  canCopy,
  focused,
  width,
  onSave,
  onCancel,
}: {
  name: string;
  onName: (name: string) => void;
  canCopy: boolean;
  focused: boolean;
  width: number;
  onSave: (copy: boolean) => void;
  onCancel: () => void;
}) {
  const ids = canCopy ? (["name", "save", "copy", "cancel"] as const) : (["name", "save", "cancel"] as const);
  type Id = (typeof ids)[number];
  const [active, setActive] = useState<Id>("name");
  const dialogOpen = useDialogState((state) => state.isOpen);
  const ring = useFieldRing<Id>({
    ids,
    activeId: active,
    onActivate: setActive,
    enabled: focused && !dialogOpen,
    scope: "live-scan-save",
    actions: { save: () => onSave(false), copy: () => onSave(true), cancel: onCancel },
  });
  useInputCapture(focused);
  useShortcut((event) => {
    if (event.name !== "escape") return;
    event.preventDefault();
    event.stopPropagation();
    onCancel();
  }, { enabled: focused && !dialogOpen, phase: "before", allowEditable: true, scope: "live-scan-save" });
  const disabled = !name.trim();
  return (
    <Box paddingX={1} paddingTop={1} flexDirection="column" gap={1}>
      <Box ref={ring.nodeRef("name")}>
        <TextField
          label="Scan name"
          value={name}
          onChange={onName}
          onSubmit={() => onSave(false)}
          focused={focused && active === "name"}
          active={active === "name"}
          onMouseDown={() => setActive("name")}
          width={Math.max(20, Math.min(45, width - 4))}
        />
      </Box>
      <Box flexDirection="row" gap={1}>
        <Box ref={ring.nodeRef("save")}>
          <Button label={canCopy ? "Update scan" : "Save scan"} variant="primary" active={focused && active === "save"} disabled={disabled} onPress={() => onSave(false)} />
        </Box>
        {canCopy ? (
          <Box ref={ring.nodeRef("copy" as Id)}>
            <Button label="Save copy" variant="secondary" active={focused && active === "copy"} disabled={disabled} onPress={() => onSave(true)} />
          </Box>
        ) : null}
        <Box ref={ring.nodeRef("cancel")}>
          <Button label="Cancel" variant="secondary" active={focused && active === "cancel"} onPress={onCancel} />
        </Box>
      </Box>
    </Box>
  );
}

export default function LiveScanPane({ focused, width, height }: PaneProps) {
  const paneId = usePaneInstanceId();
  const logos = useUiCapabilities().nativePaneChrome === true;
  const dialog = useDialog();
  const { notify, focusPane } = usePluginAppActions();
  const { pinTicker } = usePluginTickerActions();
  const { runtime } = usePluginRenderContext();
  const watchlists = useAppSelector((state) => state.config.watchlists);
  const tickers = useAppSelector((state) => state.tickers);

  const [storedScan, setStoredScan] = usePluginPaneState<unknown>("scan", DEFAULT_LIVE_SCAN);
  const scan = useMemo(() => readLiveScan(storedScan), [storedScan]);
  const [storedSaved, setStoredSaved] = usePluginPaneState<unknown>("saved", []);
  const saved = useMemo(() => readSavedLiveScans(storedSaved), [storedSaved]);
  const [currentSavedId, setCurrentSavedId] = usePluginPaneState<string | null>("currentSaved", null);
  const [alerts, setAlerts] = usePluginPaneState<boolean>("alerts", false);
  const [tab, setTab] = usePluginPaneState<Tab>("tab", "matches");
  const [sort, setSort] = usePluginPaneState<MatchSort>("sort", RANKED);
  const [selectedSymbol, setSelectedSymbol] = usePluginPaneState<string | null>("selected", null);
  const [selectedCondition, setSelectedCondition] = usePluginPaneState<string>("condition", "0");
  const [selectedSavedId, setSelectedSavedId] = usePluginPaneState<string | null>("savedSelected", null);
  // Publish the selection on this pane for linked panes, as HILO and FLOW do.
  const [, setCursorSymbol] = usePaneStateValue<string | null>("cursorSymbol", null);
  const [editing, setEditing] = useState<number | null>(null);
  const [saveForm, setSaveForm] = useState(false);
  const [name, setName] = useState("");

  const currentSaved = saved.find((entry) => entry.id === currentSavedId) ?? null;
  const scanName = currentSaved?.name ?? "Live scan";
  const wire = useMemo(() => toWireScan(scan, tickers.values()), [scan, tickers]);
  const runnable = !(wire.definition.universe.kind === "symbols" && wire.definition.universe.symbols.length === 0);
  const key = runnable ? liveScanKey(wire.definition) : "";
  // Alerts keep the scan running while the pane is covered or the app is in the background.
  const paneVisible = usePaneVisible();
  const feed = useLiveScanFeed(runnable ? wire.definition : null, key, paneVisible || alerts);
  const payload = feed.payload;
  usePaneRefreshKey(feed.reload, { focused: focused && editing === null && !saveForm });

  // Matches since the session began, and the alerts they raised.
  const trackRef = useRef<LiveScanTrack | null>(null);
  const [track, setTrack] = useState<LiveScanTrack | null>(null);
  useEffect(() => {
    if (!payload || !key) return;
    const now = Date.now();
    const step = trackLiveScan(trackRef.current, payload, key, { alerts, now });
    if (step.track === trackRef.current) return;
    trackRef.current = step.track;
    setTrack(step.track);
    const [first, ...rest] = step.alert;
    if (!first) return;
    const text = liveScanAlertText(scanName, step.alert, scan.conditions, payload.delayMinutes);
    notify({
      title: text.title,
      body: text.body,
      type: "info",
      refId: `scan:${paneId}`,
      desktop: step.loud ? "always" : "never",
      ...(step.loud ? { sound: "Glass" } : {}),
      action: { label: "Open", onClick: () => focusPane(paneId) },
    });
    const rule = `${scanName} · ${universeLabel(scan.universe, watchlists)}`;
    recordFiredAlertFor(
      runtime,
      [liveScanFiredAlert([first, ...rest], {
        ruleId: currentSaved?.id ?? paneId,
        rule,
        conditions: scan.conditions,
        delayMinutes: payload.delayMinutes,
        firedAt: now,
      })],
      logFailure("scanner.live", "Record live scan alert failed"),
      LIVE_SCAN_HISTORY_LIMIT,
    );
    // Only a new answer is folded in; the scan and its name are read as they are then.
  }, [payload]);

  const noteOf = useCallback(
    (match: LiveScanMatch) => (payload ? liveScanRowNote(match, payload, track) : null),
    [payload, track],
  );
  const matches = useMemo(() => sortMatches(payload?.matches ?? [], sort, noteOf), [noteOf, payload?.matches, sort]);
  const columns = useMemo(() => liveScanColumns(width, scan.conditions), [scan.conditions, width]);

  const apply = (next: LiveScan) => {
    setStoredScan(next);
    setEditing(null);
  };
  const switchTab = (next: string) => {
    setTab(next as Tab);
    setEditing(null);
    setSaveForm(false);
  };
  const startSave = () => {
    setName(currentSaved?.name ?? "");
    setSaveForm(true);
  };
  const save = (copy: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const update = currentSaved && !copy;
    const entry: SavedLiveScan = { id: update ? currentSaved.id : crypto.randomUUID(), name: trimmed, scan };
    const next = update ? saved.map((row) => (row.id === entry.id ? entry : row)) : [...saved, entry];
    if (next.length > LIVE_SCAN_MAX_SAVED) {
      notify({ body: `Keep at most ${LIVE_SCAN_MAX_SAVED} saved scans; delete one first.`, type: "error" });
      return;
    }
    setStoredSaved(next);
    setCurrentSavedId(entry.id);
    setSelectedSavedId(entry.id);
    setSaveForm(false);
    notify({ body: `Saved ${entry.name}`, type: "success" });
  };
  const selectedSaved = saved.find((entry) => entry.id === selectedSavedId) ?? saved[0] ?? null;
  const removeSaved = async () => {
    const entry = selectedSaved;
    if (!entry) return;
    const confirmed = await confirmDialog(dialog, {
      closeOnClickOutside: false,
      title: "Delete saved scan?",
      body: [entry.name],
      confirmLabel: "Delete",
    });
    if (!confirmed) return;
    setStoredSaved(saved.filter((row) => row.id !== entry.id));
    if (currentSavedId === entry.id) setCurrentSavedId(null);
  };
  const conditionIndex = Math.min(Number(selectedCondition) || 0, Math.max(0, scan.conditions.length - 1));
  const saveHint: PaneHint = { id: "save", key: "s", label: "ave scan", onPress: startSave };
  const hints: PaneHint[] = saveForm || editing !== null
    ? []
    : tab === "conditions"
      ? [
          { id: "add", key: "a", label: "dd condition", onPress: () => setEditing(-1), disabled: scan.conditions.length >= LIVE_SCAN_MAX_CONDITIONS },
          {
            id: "delete",
            key: "d",
            label: "elete condition",
            onPress: () => apply({ ...scan, conditions: scan.conditions.filter((_, index) => index !== conditionIndex) }),
            disabled: !scan.conditions.length,
          },
          saveHint,
        ]
      : tab === "saved"
        ? [{ id: "delete", key: "d", label: "elete", onPress: () => void removeSaved(), disabled: !selectedSaved }]
        : [saveHint];
  usePaneFooter("scanner-live:hints", () => ({ hints }), [hints]);

  const footerExtra = useMemo<PaneFooterSegment | null>(() => {
    if (feed.error && payload) return { id: "scanner-live-refresh", parts: [{ text: "refresh failed", tone: "warning" }] };
    if (payload?.asOf != null && payload.status !== "starting") {
      return { id: "scanner-live-asof", parts: [{ text: `as of ${formatScanTime(payload.asOf)}`, tone: "muted" }] };
    }
    return null;
  }, [feed.error, payload]);
  useScannerStatusFooter("scanner-live", { payload, denied: false, deniedReason: null }, focused, footerExtra);
  usePaneNoticeFooter({
    registrationId: "scanner-live:notices",
    focused,
    notices: [
      ...(payload?.warnings ?? []),
      warmingNotice(payload),
      payload && payload.matched > payload.matches.length
        ? `${payload.matched.toLocaleString("en-US")} symbols match; the ${payload.matches.length} strongest are listed. Add a condition or raise a floor to narrow the scan.`
        : null,
      wire.skipped.length
        ? `${wire.skipped.length} watchlist ${wire.skipped.length === 1 ? "row is" : "rows are"} not a US stock and ${wire.skipped.length === 1 ? "is" : "are"} left out: ${wire.skipped.slice(0, 8).join(", ")}${wire.skipped.length > 8 ? ", ..." : ""}`
        : null,
      runnable ? wire.problem : null,
      feed.error && payload ? feed.error : null,
    ].filter((notice): notice is string => !!notice),
  });

  const { strip: tabStrip, rows: tabRows } = usePaneTabs({
    tabs: TABS,
    activeValue: tab,
    onSelect: switchTab,
    focused: focused && !saveForm && editing === null,
    dense: true,
  });
  const bodyHeight = Math.max(4, height - tabRows);

  const renderMatchCell = useCallback((match: LiveScanMatch, column: DataTableColumn): DataTableCell => {
    if (column.id.startsWith("c:")) {
      const index = Number(column.id.slice(2));
      const condition = scan.conditions[index];
      const value = matchValue(match, index);
      if (!condition) return { text: "" };
      const unit = conditionUnit(condition);
      if (unit === "percent") return numberCell(value, formatPercentRaw, signColor(value));
      if (unit === "multiple") return numberCell(value, formatMultiple);
      // An event's time, in the colour of where it left the price.
      const tone = condition.kind === "new_high" ? colors.positive
        : condition.kind === "new_low" ? colors.negative
          : signColor(match.vwapPercent);
      return value == null ? { text: "--", color: colors.textDim } : { text: formatScanTime(value), value: new Date(value).toISOString(), ...(tone ? { color: tone } : {}) };
    }
    switch (column.id) {
      case "symbol":
        return { text: match.symbol, attributes: TextAttributes.BOLD };
      case "name":
        return withCompanyLogo({ text: match.name ?? "--" }, { symbol: match.symbol, name: match.name ?? undefined }, logos);
      case "price":
        return { text: formatHiloPrice(match.price), value: match.price };
      case "change":
        return numberCell(match.changePercent, formatPercentRaw, signColor(match.changePercent));
      case "volume":
        return numberCell(match.volume, (value) => formatCompact(value));
      case "rvol":
        return numberCell(match.relativeVolume, formatMultiple);
      case "vwap":
        return numberCell(match.vwapPercent, formatPercentRaw, signColor(match.vwapPercent));
      case "gap":
        return numberCell(match.gapPercent, formatPercentRaw, signColor(match.gapPercent));
      case "status": {
        const note = noteOf(match);
        if (!note) return { text: "" };
        const color = note.kind === "stale" ? colors.warning : note.kind === "new" ? colors.positive : colors.text;
        return { text: noteText(note), color, keepColorWhenSelected: note.kind === "stale" };
      }
      default:
        return { text: "" };
    }
  }, [logos, noteOf, scan.conditions]);

  const universeChoices = useMemo(() => universeOptions(watchlists), [watchlists]);
  const queryBar = (
    <QueryBar
      width={width}
      filters={[
        {
          id: "universe",
          label: "Universe",
          value: universeValue(scan.universe),
          defaultValue: "all",
          options: universeChoices.some((option) => option.value === universeValue(scan.universe))
            ? universeChoices
            : [...universeChoices, { value: universeValue(scan.universe), label: universeLabel(scan.universe, watchlists) }],
          onChange: (value: string) => apply({ ...scan, universe: parseUniverseValue(value) }),
        },
        {
          id: "min-price",
          label: "Price",
          value: floorValue(scan.minPrice),
          defaultValue: floorValue(DEFAULT_LIVE_SCAN.minPrice),
          options: MIN_PRICE_OPTIONS,
          onChange: (value: string) => apply({ ...scan, minPrice: parseFloorValue(value) }),
        },
        {
          id: "min-cap",
          label: "Mkt cap",
          value: floorValue(scan.minMarketCap),
          defaultValue: floorValue(DEFAULT_LIVE_SCAN.minMarketCap),
          options: MIN_CAP_OPTIONS,
          onChange: (value: string) => apply({ ...scan, minMarketCap: parseFloorValue(value) }),
        },
        {
          id: "min-volume",
          label: "Volume",
          value: floorValue(scan.minVolume),
          defaultValue: floorValue(DEFAULT_LIVE_SCAN.minVolume),
          options: MIN_VOLUME_OPTIONS,
          onChange: (value: string) => apply({ ...scan, minVolume: parseFloorValue(value) }),
        },
        { kind: "toggle", id: "alerts", label: "Alerts", value: alerts, onChange: setAlerts },
      ]}
    />
  );

  const matchesBody = (
    <DataTableView<LiveScanMatch>
      focused={focused && !saveForm}
      rootBefore={queryBar}
      rootWidth={width}
      rootHeight={bodyHeight}
      columns={columns}
      items={matches}
      getItemKey={(match) => match.symbol}
      selection={{
        kind: "id",
        selectedId: selectedSymbol,
        getId: (match) => match.symbol,
        onChange: (id) => {
          setSelectedSymbol(id);
          setCursorSymbol(id);
        },
      }}
      // The listing on its US venue: a bare CRWD also names its TSX and Mexican lines.
      onActivate={(match) => pinTicker(publicTickerKey(match.symbol, match.exchange ?? undefined), { floating: true, paneType: TICKER_RESEARCH_PANE_ID, instrument: null })}
      renderCell={renderMatchCell}
      selectedTextOverridesCellColor
      sortColumnId={sort.column}
      sortDirection={sort.direction}
      onHeaderClick={(column) => setSort((current) => (
        current.column !== column ? { column, direction: "desc" }
          : current.direction === "desc" ? { column, direction: "asc" }
            : RANKED
      ))}
      onSortChange={(column, direction) => setSort({ column, direction })}
      status={
        !runnable ? { empty: true, emptyTitle: wire.problem ?? "Nothing to scan." }
          : !payload && feed.error ? { error: feed.error, subject: "live scan", retry: { onRetry: feed.reload } }
            : !payload ? { loading: true, loadingLabel: "Waiting for the scanner..." }
              : undefined
      }
      emptyStateTitle={emptyState(payload).title}
      emptyStateHint={emptyState(payload).hint}
    />
  );

  const editingCondition = editing !== null && editing >= 0 ? scan.conditions[editing] ?? null : null;
  const conditionsBody = (
    <PageStackView
      focused={focused && !saveForm}
      detailOpen={editing !== null}
      onBack={() => setEditing(null)}
      detailTitle={editingCondition ? conditionText(editingCondition) : "New condition"}
      detailContent={editing !== null ? (
        <LiveConditionEditor
          key={editing}
          value={editingCondition}
          focused={focused}
          width={width}
          onCancel={() => setEditing(null)}
          onSave={(condition) => {
            const conditions = [...scan.conditions];
            if (editing < 0) conditions.push(condition);
            else conditions[editing] = condition;
            apply({ ...scan, conditions });
          }}
        />
      ) : null}
      rootContent={(
        <DataTableView<{ id: string; condition: LiveScanCondition }>
          columns={[{ id: "condition", label: "CONDITION", width: 24, flexGrow: 1, align: "left" }]}
          items={scan.conditions.map((condition, index) => ({ id: String(index), condition }))}
          focused={focused && editing === null && !saveForm}
          rootWidth={width}
          rootHeight={bodyHeight}
          getItemKey={(row) => row.id}
          selection={{ kind: "id", selectedId: String(conditionIndex), getId: (row) => row.id, onChange: setSelectedCondition }}
          onActivate={(row) => setEditing(Number(row.id))}
          renderCell={(row) => ({ text: conditionText(row.condition) })}
          sortColumnId={null}
          sortDirection="asc"
          emptyStateTitle="No conditions. Every stock above the floors matches, biggest movers first."
        />
      )}
    />
  );

  const savedBody = (
    <DataTableView<SavedLiveScan>
      columns={[
        { id: "name", label: "SCAN", width: 20, align: "left" },
        { id: "universe", label: "UNIVERSE", width: 18, align: "left" },
        { id: "conditions", label: "CONDITIONS", width: 20, flexGrow: 1, align: "left" },
      ]}
      items={saved}
      focused={focused && !saveForm}
      rootWidth={width}
      rootHeight={bodyHeight}
      getItemKey={(row) => row.id}
      selection={{ kind: "id", selectedId: selectedSaved?.id ?? null, getId: (row) => row.id, onChange: setSelectedSavedId }}
      onActivate={(row) => {
        apply(row.scan);
        setCurrentSavedId(row.id);
        setTab("matches");
      }}
      renderCell={(row, column) => ({
        text: column.id === "name"
          ? row.name
          : column.id === "universe"
            ? universeLabel(row.scan.universe, watchlists)
            : row.scan.conditions.map(conditionText).join("; ") || "Floors only",
        ...(column.id === "name" && row.id === currentSavedId ? { attributes: TextAttributes.BOLD } : {}),
      })}
      sortColumnId={null}
      sortDirection="asc"
      emptyStateTitle="No saved scans."
      emptyStateHint="Save the scan you are running from Matches or Conditions."
    />
  );

  return (
    <Box width={width} height={height} flexDirection="column">
      {tabStrip}
      <PageStackView
        focused={focused}
        detailOpen={saveForm}
        onBack={() => setSaveForm(false)}
        detailTitle="Save scan"
        rootContent={tab === "conditions" ? conditionsBody : tab === "saved" ? savedBody : matchesBody}
        detailContent={saveForm ? (
          <SaveScanForm
            name={name}
            onName={setName}
            canCopy={!!currentSaved}
            focused={focused}
            width={width}
            onSave={save}
            onCancel={() => setSaveForm(false)}
          />
        ) : null}
      />
    </Box>
  );
}
