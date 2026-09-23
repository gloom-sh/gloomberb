import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ChoiceDialog, ConfirmDialog, DataTableView, EmptyState, KeyValueRow,
  PageStackView, PaneStatusBody, QueryBar, Tabs, usePaneFooter, usePaneHeaderTabs, usePaneNoticeFooter, type DataTableColumn, type SelectControl } from "../../../components";
import { useAsyncResource, useInputCapture, usePaneInstance, usePaneSettingValue, usePaneTicker,
  usePluginAppActions, usePluginPaneState, usePluginState, useShortcut } from "../../../public/react";
import { Box, Text } from "../../../ui";
import { useDialogState } from "../../../ui/dialog";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import type { PaneProps } from "../../../types/plugin";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex } from "../../../theme/color-utils";
import { resolveOptionsTarget } from "../../../utils/options";
import { optionMid } from "../shared/volatility";
import { daysToExpiryFrom } from "../options-calculator/model";
import { ScenarioPayoffChart } from "./charts";
import { ScenarioLegEditor, ScenarioSaveForm, ScenarioInputsForm } from "./editor";
import { loadScenarioMarket, scenarioPositionFromSettings, scenarioControlsFromSettings, type ScenarioMarketSnapshot } from "./client";
import { buildScenario, type ScenarioLeg, type ScenarioPosition, type ScenarioControls, validatePosition } from "./model";
import { EMPTY_SAVED_STRATEGIES, restoreSavedStrategies, type SavedScenarioStrategy } from "./state";
import { useScenarioEvidence } from "./evidence";

const EMPTY_ERRORS: string[] = [];
const TABS = [{ value: "payoff", label: "Payoff" }, { value: "grid", label: "P&L grid" }, { value: "legs", label: "Legs" }];
const dateLabel = (value: number) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString().slice(0, 10) : "--";
const money = (value: number | null) => value == null || !Number.isFinite(value) ? "--" : value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function OptionsScenarioPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const dialog = useDialog();
  const { notify } = usePluginAppActions();
  const { symbol, ticker } = usePaneTicker();
  const instance = usePaneInstance();
  const settings = instance?.settings ?? {};
  const [frozen] = usePaneSettingValue<ReturnType<typeof buildScenario> | null>("scenarioSnapshot", null);
  const [snapshotErrors] = usePaneSettingValue<string[]>("scenarioSnapshotErrors", EMPTY_ERRORS);
  const [frozenMarket] = usePaneSettingValue<ScenarioMarketSnapshot | null>("scenarioMarketSnapshot", null);
  const target = resolveOptionsTarget(ticker);
  const underlying = target?.effectiveTicker ?? symbol ?? String(settings.symbol ?? "");
  const exchange = target?.effectiveExchange || undefined;
  const [expiration, setExpiration] = usePluginPaneState<number | null>("chainExpiration", null);
  const [tab, setTab] = usePluginPaneState("activeTabId", "payoff");
  const [detail, setDetail] = useState<"chain" | "leg" | "save" | "inputs" | null>(null);
  const [editingLeg, setEditingLeg] = useState<ScenarioLeg | null>(null);
  const [gridIndex, setGridIndex] = useState(0);
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedLegId", null);
  const [rawSaved, setSaved] = usePluginState<SavedScenarioStrategy[]>("osa-strategies", EMPTY_SAVED_STRATEGIES, { schemaVersion: 1 });
  const restored = useMemo(() => restoreSavedStrategies(rawSaved), [rawSaved]);
  const saved = restored.strategies;
  const [consumedSeed, setConsumedSeed] = usePluginPaneState<string | null>("consumedSeed", null);
  const [localError, setLocalError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const explicitSpot = Number(settings.spot);
  const loadMarket = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    return loadScenarioMarket({ instrument: { symbol: underlying, exchange: target?.effectiveExchange },
      expiration: expiration ?? undefined, forceRefresh: force, signal: abort.signal });
  }, [underlying, target?.effectiveExchange, expiration]);
  // Fully specified calculations and screenshot snapshots never need a quote refresh.
  const needsMarket = !frozen && (!["spot", "rate", "dividendYield"].every((key) => settings[key] != null && settings[key] !== "") || detail === "chain");
  const resource = useAsyncResource(underlying && needsMarket ? loadMarket : null);
  useEffect(() => () => controller.current?.abort(), [loadMarket]);
  const rawMarket = frozenMarket ?? resource.data;
  const market = rawMarket?.symbol === underlying ? rawMarket : null;
  const seeded = useMemo(() => {
    try { return { value: scenarioPositionFromSettings({ ...settings, symbol: underlying, exchange }, market ?? undefined), error: null }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [settings, underlying, exchange, market]);
  const [stored, setPosition] = usePluginPaneState<ScenarioPosition | null>("position", seeded.value);
  const position = stored?.symbol === underlying && (!exchange || stored.exchange === exchange) ? stored : seeded.value;
  const [controlState, setControls] = usePluginPaneState<ScenarioControls | null>("controls", null);
  const baseControls = useMemo(() => {
    try { return { value: position ? scenarioControlsFromSettings(settings, position) : null, error: null }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [settings, position]);
  const controls = controlState ?? baseControls.value;
  const result = useMemo(() => {
    if (frozen) return { scenario: frozen, error: null };
    if (!controlState && baseControls.error) return { scenario: null, error: baseControls.error };
    if (!position?.legs.length) return { scenario: null, error: seeded.error };
    try { return { scenario: buildScenario(position, controls ?? {}), error: null }; }
    catch (error) { return { scenario: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [frozen, position, controls, seeded.error, controlState, baseControls.error]);
  const scenario = result.scenario;
  const error = localError ?? result.error;
  const baseline = (): ScenarioPosition => position ?? { symbol: underlying, exchange, currency: String(settings.currency ?? (market?.currency || "UNKNOWN")),
    spot: Number.isFinite(explicitSpot) ? explicitSpot : market?.spot ?? NaN,
    rate: settings.rate != null ? Number(settings.rate) / 100 : market?.rate ?? NaN,
    dividendYield: settings.dividendYield != null ? Number(settings.dividendYield) / 100 : market?.dividendYield ?? NaN,
    asOf: settings.asOf ? Date.parse(String(settings.asOf)) : market?.asOf ?? Date.now(), legs: [] };
  const edit = (leg: ScenarioLeg) => { setEditingLeg(leg); setDetail(validatePosition({ ...baseline(), legs: [leg] }) ? "inputs" : "leg"); setLocalError(null); };
  const addTyped = () => {
    const base = baseline();
    const expiration = base.legs[0]?.expiration ?? Math.floor(Date.parse(dateLabel((Number.isFinite(base.asOf) ? base.asOf : Date.now()) + 30 * 86_400_000)) / 1000);
    edit({ id: crypto.randomUUID(), side: "call", quantity: 1, strike: base.spot, expiration, price: 0, volatility: .25, multiplier: 100 });
  };
  useEffect(() => {
    const raw = settings.seedLeg;
    if (typeof raw !== "string" || raw === consumedSeed || resource.loading) return;
    try {
      const leg = JSON.parse(raw) as ScenarioLeg;
      // Validate the complete candidate before displaying a persisted handoff.
      edit(leg); setConsumedSeed(raw);
    } catch (error) { setLocalError(error instanceof Error ? error.message : String(error)); setConsumedSeed(raw); }
  }, [settings.seedLeg, consumedSeed, resource.loading]);
  const selected = position?.legs.find((leg) => leg.id === selectedId) ?? position?.legs[0];
  const remove = async () => {
    if (!selected || !position) return;
    const yes = await dialog.prompt<boolean>({ content: (ctx: PromptContext<boolean>) => <ConfirmDialog {...ctx} title="Remove leg?"
      body={`${selected.quantity > 0 ? "Buy" : "Sell"} ${Math.abs(selected.quantity)} ${selected.side} ${selected.strike}`} confirmLabel="Remove" /> }).catch(() => false);
    if (yes) setPosition({ ...position, legs: position.legs.filter((leg) => leg.id !== selected.id) });
  };
  const loadSaved = async () => {
    const choices = saved.filter((entry) => entry.position.symbol === underlying && (!exchange || entry.position.exchange === exchange));
    if (!choices.length) { notify({ body: "No saved strategies for this ticker." }); return; }
    const id = await dialog.prompt<string>({ content: (ctx: PromptContext<string>) => <ChoiceDialog {...ctx} title="Load strategy"
      choices={choices.map((entry) => ({ id: entry.id, label: entry.name, detail: dateLabel(entry.position.asOf) }))} /> }).catch(() => "");
    const selected = choices.find((entry) => entry.id === id);
    if (selected) { setPosition(selected.position); setControls(selected.controls); setLocalError(null); }
  };
  const save = (name: string) => {
    if (!scenario) return;
    setSaved((entries) => [...restoreSavedStrategies(entries).strategies, { id: crypto.randomUUID(), name, position: scenario.position, controls: scenario.controls }]);
    setDetail(null); notify({ body: `Saved ${name}`, type: "success" });
  };
  const [sort, setSort] = useState({ id: "strike", direction: "asc" as "asc" | "desc" });
  const [gridSort, setGridSort] = useState({ id: "spot", direction: "asc" as "asc" | "desc" });
  const [chainSort, setChainSort] = useState({ id: "strike", direction: "asc" as "asc" | "desc" });
  const [volText, setVolText] = useState(String((controls?.volShift ?? 0) * 100));
  const dateControl = useRef<SelectControl>(null);
  const chainExpiryControl = useRef<SelectControl>(null);
  const [volActive, setVolActive] = useState(false);
  useInputCapture(focused && volActive);
  useEffect(() => { if (!volActive) setVolText(String((controls?.volShift ?? 0) * 100)); }, [controls?.volShift, volActive]);
  const shiftVol = (text: string) => {
    if (!text.trim() || !Number.isFinite(Number(text)) || !scenario) return;
    setControls({ ...scenario.controls, volShift: Number(text) / 100 });
  };
  const hints = detail === "chain" ? [{ id: "expiry", key: "d", label: "ate", onPress: () => chainExpiryControl.current?.open() }] : detail || volActive ? [] : [
    { id: "add", key: "a", label: "dd leg", onPress: addTyped },
    { id: "chain", key: "c", label: "hain", onPress: () => setDetail("chain") },
    { id: "inputs", key: "i", label: "nputs", onPress: () => setDetail("inputs") },
    ...(selected && tab === "legs" ? [{ id: "edit", key: "e", label: "dit", onPress: () => edit(selected) },
      { id: "remove", key: "x", label: "remove", onPress: () => void remove() }] : []),
    ...(scenario ? [{ id: "date", key: "d", label: "ate", onPress: () => dateControl.current?.open() }, { id: "save", key: "s", label: "ave", onPress: () => setDetail("save") }] : []),
    { id: "load", key: "b", label: "rowse saved", onPress: () => void loadSaved() },
  ];
  const notices = [...new Set([...restored.warnings, ...(market?.warnings ?? []), ...(scenario?.warnings ?? []), ...(resource.error ? [resource.error] : [])])];
  usePaneNoticeFooter({ registrationId: "osa-notices", notices, focused, enabled: !detail || detail === "chain" });
  usePaneFooter("osa", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading chain", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ...(position ? [{ id: "asof", parts: [{ text: `${dateLabel(position.asOf)} · ${market?.source ? "market" : "input assumptions"}`, tone: "muted" as const }] }] : []),
  ], hints }), [hints, position, market?.source, resource.loading, error]);
  useScenarioEvidence({ scenario, view: tab, loading: !!resource.loading && !scenario, error: error ?? (snapshotErrors.join("; ") || null), notices });
  // A choice dialog (scenario date, saved strategies) owns the keys while open.
  const dialogOpen = useDialogState((state) => state.isOpen);
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || dialogOpen) return;
    if (volActive) {
      if (["escape", "tab", "enter", "return"].includes(event.name ?? "")) {
        event.preventDefault(); event.stopPropagation(); shiftVol(volText); setVolActive(false);
      }
      return;
    }
    if (detail && detail !== "chain" || event.targetEditable || event.ctrl || event.alt || event.meta) return;
    if (event.name === "tab" && scenario) {
      event.preventDefault(); event.stopPropagation(); setVolActive(true); return;
    }
    const hint = hints.find((hint) => hint.key === event.name);
    if (hint) { event.preventDefault(); event.stopPropagation(); hint.onPress(); }
    else if (event.name === "r") void resource.reload();
  }, { enabled: focused && !dialogOpen, phase: "before", scope: "osa-actions", allowEditable: true });
  const controlsHeight = 1;
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused: focused && !volActive });
  const tabRows = tabsInHeader ? 0 : 1;
  const bodyHeight = Math.max(3, height - 7 - tabRows - controlsHeight);
  const legColumns: DataTableColumn[] = [{ id: "quantity", label: "Contracts", width: 10, align: "right" },
    { id: "side", label: "Option", width: 7, align: "left" }, { id: "strike", label: "Strike", width: 11, align: "right" },
    { id: "expiration", label: "Expiry", width: 12, align: "left" }, { id: "price", label: "Entry / unit", width: 13, align: "right" },
    { id: "volatility", label: "IV %", width: 9, align: "right" }, { id: "multiplier", label: "Units", width: 7, align: "right" }];
  const risk = scenario?.expiryRisk;
  const activeContent = scenario && tab === "payoff" ? <ScenarioPayoffChart scenario={scenario} width={width} height={bodyHeight} />
    : scenario && tab === "grid" ? <DataTableView focused={focused && !volActive} rootWidth={width}
      rootHeight={Math.min(bodyHeight, scenario.grid.length + 1)} items={scenario.grid.toSorted((a, b) => { const value = (row: typeof a) => gridSort.id === "spot" ? row.spot : gridSort.id === "move" ? row.move ?? 0 : row.values[Number(gridSort.id)] ?? 0; return (value(a) - value(b)) * (gridSort.direction === "asc" ? 1 : -1); })}
      sortColumnId={gridSort.id} sortDirection={gridSort.direction} onHeaderClick={(id) => setGridSort({ id, direction: gridSort.id === id && gridSort.direction === "asc" ? "desc" : "asc" })}
      emptyStateTitle="No scenario values." getItemKey={(row) => `${row.landmark ?? "step"}:${row.spot}`}
      columns={[{ id: "spot", label: `Spot ${position?.currency ?? ""}`, width: 14, align: "right" }, { id: "move", label: "Move %", width: 10, align: "right" },
        { id: "mark", label: "", width: 10, align: "left" },
        ...scenario.dates.map((date, i) => ({ id: String(i), label: dateLabel(date).slice(5), width: 13, align: "right" as const }))]}
      renderCell={(row, column) => {
        const atSpot = row.move != null && Math.abs(row.move) < 1e-9;
        if (column.id === "spot") return { text: money(row.spot), color: row.landmark ? colors.warning : atSpot ? colors.textBright : colors.text };
        if (column.id === "move") return { text: row.move == null ? "--" : `${row.move > 0 ? "+" : ""}${(row.move * 100).toFixed(1)}`, color: colors.textMuted };
        if (column.id === "mark") return { text: row.landmark ?? (atSpot ? "spot" : ""), color: row.landmark ? colors.warning : colors.textMuted };
        const value = row.values[Number(column.id)] ?? 0;
        // Shade by size so the profit zone and the wings read at a glance.
        const peak = Math.max(1, ...scenario.grid.flatMap((entry) => entry.values.map(Math.abs)));
        return { text: money(value), color: value >= 0 ? colors.positive : colors.negative,
          backgroundColor: blendHex(colors.bg, value >= 0 ? colors.positive : colors.negative, 0.06 + 0.3 * Math.min(1, Math.abs(value) / peak)) };
      }} selection={{ kind: "index", selectedIndex: gridIndex, onChange: setGridIndex }} onActivate={() => {}} />
    : <DataTableView<ScenarioLeg> focused={focused && !volActive} rootWidth={width} rootHeight={Math.min(bodyHeight, (position?.legs.length ?? 0) + 1)}
      items={(position?.legs ?? []).toSorted((a, b) => { const x = a[sort.id as keyof ScenarioLeg], y = b[sort.id as keyof ScenarioLeg]; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * (sort.direction === "asc" ? 1 : -1); })}
      sortColumnId={sort.id} sortDirection={sort.direction} onHeaderClick={(id) => setSort({ id, direction: sort.id === id && sort.direction === "asc" ? "desc" : "asc" })}
      emptyStateTitle="No position legs." columns={legColumns} getItemKey={(leg) => leg.id}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (leg) => leg.id, onChange: (id) => setSelectedId(id) }}
      onActivate={edit} renderCell={(leg, column) => ({ text: column.id === "expiration" ? dateLabel(leg.expiration * 1000)
        : column.id === "volatility" ? (leg.volatility * 100).toFixed(2)
        : column.id === "price" || column.id === "strike" ? money(leg[column.id])
        : String(leg[column.id as keyof ScenarioLeg]), color: column.id === "quantity" ? leg.quantity > 0 ? colors.positive : colors.negative : colors.text })} />;
  const root = <>
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={setTab} variant="underline" dense focused={focused && !volActive} />}
    {scenario && <>
      <QueryBar
        width={width}
        filters={[
          { id: "date", label: "Scenario date", controlRef: dateControl, value: String(scenario.controls.date),
            options: [...new Set([...scenario.dates, scenario.controls.date])].sort((a, b) => a - b)
              .map((date) => ({ value: String(date), label: `${dateLabel(date)} +${((date - scenario.position.asOf) / 86_400_000).toFixed(1)}d` })),
            onChange: (value: string) => setControls({ ...scenario.controls, date: Number(value) }) },
          { id: "vol", kind: "text", label: "Vol shift (pts)", width: 12, placeholder: "vol shift", debounceMs: 0,
            value: !volActive && volText === "0" ? "" : volText, focused, active: volActive,
            onActiveChange: (active: boolean) => { if (!active) shiftVol(volText); setVolActive(active); },
            onChange: (value: string) => { setVolText(value); shiftVol(value.trim() ? value : "0"); } },
        ]}
      />
      <Box paddingX={1} height={1} flexDirection="row" gap={3}>
        <KeyValueRow label={`P&L ${scenario.position.currency}`} value={money(scenario.valuation.pnl)} color={scenario.valuation.pnl >= 0 ? colors.positive : colors.negative} width={28} />
        <KeyValueRow label="Spot" value={money(scenario.position.spot)} width={23} />
        <KeyValueRow label="Value" value={money(scenario.valuation.price)} width={28} />
      </Box>
      <Box paddingX={1} height={1} flexDirection="row" gap={2}>
        <KeyValueRow label="Max profit" labelWidth={12} value={risk?.unlimitedProfit ? "Unlimited" : money(risk?.maxProfit ?? null)} width={29} />
        <KeyValueRow label="Max loss" labelWidth={11} value={risk?.unlimitedLoss ? "Unlimited" : money(risk?.maxLoss ?? null)} width={27} />
        <KeyValueRow label="Breakevens" value={risk?.breakevens.map(money).join(", ") || "--"} width={Math.max(20, width - 63)} />
      </Box>
      <Box paddingX={1} height={1} flexDirection="row" gap={2}>
        <Text fg={colors.textDim}>{`Delta ${scenario.valuation.delta.toFixed(2)}  Gamma ${scenario.valuation.gamma.toFixed(3)}  Theta ${money(scenario.valuation.thetaPerDay)}/day  Vega ${money(scenario.valuation.vegaPerPoint)}/pt  Rho ${money(scenario.valuation.rhoPerPoint)}/pt`}</Text>
      </Box>
      <Box height={1} />
    </>}
    {!position?.legs.length && !scenario ? <PaneStatusBody loading={!!resource.loading && !market} error={seeded.error} subject="scenario inputs">
      <Box paddingX={1}><EmptyState title="Build an options position." actions={<Button label="Add leg" onPress={addTyped} />} /></Box>
    </PaneStatusBody> : !scenario && tab !== "legs" ? <Box paddingX={1}><EmptyState title="Scenario unavailable." hint={error ?? undefined}
      actions={<Button label="Edit inputs" onPress={() => setDetail("inputs")} />} /></Box> : activeContent}
  </>;
  const chainRows = [...(market?.chain?.calls ?? []).map((contract) => ({ ...contract, side: "call" as const })),
    ...(market?.chain?.puts ?? []).map((contract) => ({ ...contract, side: "put" as const }))].sort((a, b) => a.strike - b.strike || a.side.localeCompare(b.side));
  const [chainSelection, setChainSelection] = useState<string | null>(null);
  const chainDetail = <>
    <QueryBar width={width} filters={[{ id: "expiry", label: "Expiry", controlRef: chainExpiryControl,
      value: String(expiration ?? market?.chain?.calls[0]?.expiration ?? market?.chain?.puts[0]?.expiration ?? ""),
      options: (market?.expirationDates ?? []).map((date) => ({ value: String(date), label: dateLabel(date * 1000) })),
      onChange: (value: string) => setExpiration(Number(value)) }]} />
    <PaneStatusBody loading={!!resource.loading && !chainRows.length} error={!chainRows.length ? resource.error : null}
      empty={!resource.loading && !chainRows.length} subject="option chain">
      <DataTableView focused={focused} rootWidth={width} rootHeight={Math.max(3, height - 2)} items={chainRows.toSorted((a, b) => { const value = (row: typeof a) => chainSort.id === "iv" ? row.impliedVolatility : chainSort.id === "oi" ? row.openInterest ?? 0 : row[chainSort.id as "side" | "strike" | "bid" | "ask"]; const x = value(a), y = value(b); return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * (chainSort.direction === "asc" ? 1 : -1); })}
        sortColumnId={chainSort.id} sortDirection={chainSort.direction} onHeaderClick={(id) => setChainSort({ id, direction: chainSort.id === id && chainSort.direction === "asc" ? "desc" : "asc" })}
        emptyStateTitle="No quoted contracts."
        columns={[{ id: "side", label: "Option", width: 8, align: "right" }, { id: "strike", label: "Strike", width: 12, align: "right" },
          { id: "bid", label: "Bid", width: 12, align: "right" }, { id: "ask", label: "Ask", width: 12, align: "right" },
          { id: "iv", label: "IV %", width: 10, align: "right" }, { id: "oi", label: "OI", width: 10, align: "right" }]}
        getItemKey={(row) => row.contractSymbol}
        selection={{ kind: "id", selectedId: chainSelection, getId: (row) => row.contractSymbol, onChange: (id) => setChainSelection(id) }}
        onActivate={(row) => edit({ id: crypto.randomUUID(), side: row.side, quantity: 1, strike: row.strike,
          expiration: row.expiration, price: optionMid(row) ?? (row.lastPrice > 0 ? row.lastPrice : 0),
          volatility: Number.isFinite(row.impliedVolatility) && row.impliedVolatility >= 0 ? row.impliedVolatility : 0, multiplier: 100 })}
        renderCell={(row, column) => ({ text: column.id === "side" ? row.side : column.id === "iv" ? (row.impliedVolatility > 0 ? (row.impliedVolatility * 100).toFixed(2) : "--")
          : column.id === "oi" ? String(row.openInterest ?? "--") : money(row[column.id as "strike" | "bid" | "ask"]) })} />
    </PaneStatusBody>
  </>;
  return <Box flexDirection="column" width={width} height={height} overflow="hidden">
    <PageStackView focused={focused} detailOpen={detail != null} onBack={() => { setDetail(null); setEditingLeg(null); }} rootContent={root}
      detailTitle={detail === "chain" ? "Choose contract" : detail === "leg" ? "Position leg" : detail === "save" ? "Save strategy" : "Scenario inputs"}
      detailContent={detail === "chain" ? chainDetail : detail === "leg" && editingLeg ? <ScenarioLegEditor key={editingLeg.id}
        leg={editingLeg} focused={focused} width={width} onCancel={() => { setDetail(null); setEditingLeg(null); }} onSave={(leg) => {
          const current = baseline();
          const legs = current.legs.some((entry) => entry.id === leg.id) ? current.legs.map((entry) => entry.id === leg.id ? leg : entry) : [...current.legs, leg];
          setPosition({ ...current, legs }); setSelectedId(leg.id); setDetail(null); setEditingLeg(null); setLocalError(null);
        }} /> : detail === "save" ? <ScenarioSaveForm focused={focused} onSave={save} onCancel={() => { setDetail(null); setEditingLeg(null); }} />
        : detail === "inputs" ? <ScenarioInputsForm position={baseline()} controls={controls} focused={focused} width={width}
          onCancel={() => { setDetail(null); setEditingLeg(null); }} onSave={(position, controls) => { setPosition(position); setControls(controls); if (editingLeg && !Number.isFinite(editingLeg.strike)) setEditingLeg({ ...editingLeg, strike: position.spot }); setDetail(editingLeg ? "leg" : null); setLocalError(null); }} /> : null} />
  </Box>;
}
