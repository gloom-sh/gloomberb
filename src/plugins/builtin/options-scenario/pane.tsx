import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { splitDelayedStatus, Button, ChoiceDialog, confirmDialog, DataTableView, EmptyState, PageStackView, PaneStatusBody, QueryBar, StatGrid, statGridRows,
  usePaneFooter, usePaneNoticeFooter, usePaneTabs, type DataTableColumn, type SelectControl, type StatItem } from "../../../components";
import { useAsyncResource, useInputCapture, usePaneInstance, usePaneSettingValue, usePaneTicker,
  usePaneNotify, usePluginPaneState, usePluginState, useShortcut } from "../../../public/react";
import { usePaneAppConfig } from "../../../state/app/context";
import { usePluginBrokerActions, usePluginTickerActions } from "../../runtime";
import { brokerCanTrade, brokerCanTradeStrategy, openTradeTicket } from "../broker-trading/command";
import { MAX_STRATEGY_LEGS, strategyFromLegs } from "../broker-trading/strategy";
import { optionContractName } from "../../../utils/options";
import { Box } from "../../../ui";
import { useDialogState } from "../../../ui/dialog";
import { useDialog, type PromptContext } from "../../../ui/dialog";
import type { PaneProps } from "../../../types/plugin";
import { useThemeColors } from "../../../theme/theme-context";
import { blendHex } from "../../../theme/color-utils";
import { resolveOptionsTarget } from "../../../utils/options";
import { buildQuoteKey, resolveEntryData } from "../../../market-data/selectors";
import { useLiveQuoteEntries } from "../../../state/hooks/quote-streaming";
import type { QuoteSubscriptionTarget } from "../../../types/data-provider";
import { optionMid } from "../shared/volatility";
import { useLiveStreamingSetting } from "../../../state/hooks/live-streaming";
import { isPlainKey } from "../../../utils/keyboard";
import { nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { buildOptionQuoteKey, freshOptionQuote, OPTIONS_QUOTE_EXCHANGE } from "../options/live-quotes";
import { liveScenarioPosition, scenarioLegContractSymbol } from "./live";
import { ScenarioPayoffChart } from "./charts";
import { ScenarioLegEditor, ScenarioSaveForm, ScenarioInputsForm } from "./editor";
import { loadScenarioMarket, scenarioControlsFromSettings, scenarioPositionFromSettings, scenarioSpotBasis, scenarioSpotStamp, scenarioSpotStampVariants, suppliedScenarioInputs,
  type ScenarioMarketSnapshot } from "./client";
import { scenarioFreshness } from "./freshness";
import { cashSecuredPut, cspStatItems, loadNextEarningsDate } from "./csp";
import { collarStatItems, scenarioCollar } from "./collar";
import { useAssetData } from "../../runtime";
import { extendedSession, formatSpotTime } from "../options/model-spot";
import { useRemoteUiNode } from "../../../remote/semantic-tree";
import { buildScenario, currencyLabel, scenarioCurrency, scenarioValueUnit, UNKNOWN_CURRENCY, type ScenarioLeg, type ScenarioPosition,
  type ScenarioControls, validatePosition } from "./model";
import { EMPTY_SAVED_STRATEGIES, restoreSavedStrategies, type SavedScenarioStrategy } from "./state";
import { useScenarioEvidence } from "./evidence";
import { hedgeStatItems, scenarioHedgeBudget, type HedgeQuote } from "./hedge";
import { readOptionExpiration } from "../../../utils/option-expiry";
import { parsePublicTickerKey } from "../../../utils/exchanges";

const EMPTY_ERRORS: string[] = [];
const TABS = [{ value: "payoff", label: "Payoff" }, { value: "grid", label: "P&L grid" }, { value: "legs", label: "Legs" }];
const dateLabel = (value: number) => Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString().slice(0, 10) : "--";
// Float noise at a flat origin reads as zero, not a red -0.00.
const cents = (value: number) => Math.abs(value) < 0.005 ? 0 : value;
const money = (value: number | null) => value == null || !Number.isFinite(value) ? "--" : cents(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function OptionsScenarioPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const dialog = useDialog();
  const notify = usePaneNotify();
  const { symbol, ticker } = usePaneTicker();
  const instance = usePaneInstance();
  const settings = instance?.settings ?? {};
  const [frozen] = usePaneSettingValue<ReturnType<typeof buildScenario> | null>("scenarioSnapshot", null);
  const [snapshotErrors] = usePaneSettingValue<string[]>("scenarioSnapshotErrors", EMPTY_ERRORS);
  const [frozenMarket] = usePaneSettingValue<ScenarioMarketSnapshot | null>("scenarioMarketSnapshot", null);
  const target = resolveOptionsTarget(ticker);
  // A listing is keyed "SPY:ARCX", both in the pane's binding and in the ticker record opened under it: split either.
  const listed = parsePublicTickerKey(target?.effectiveTicker ?? symbol ?? String(settings.symbol ?? ""));
  const underlying = listed.symbol;
  const exchange = listed.exchange || target?.effectiveExchange || undefined;
  // A strategy seeded for an expiry (`OSA SPY --strategy put --expiration 2027-01-15`) opens that expiry's chain.
  const [expiration, setExpiration] = usePluginPaneState<number | null>("chainExpiration", readOptionExpiration(settings.expiration));
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
  const brokerInstrument = target?.instrument ?? null;
  const explicitSpot = Number(settings.spot);
  const loadMarket = useCallback(async (force: boolean) => {
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    // The chain OMON reads for this ticker, from its broker when it is linked to one: one chain, one source, one cache entry.
    return loadScenarioMarket({ instrument: { symbol: underlying, exchange, brokerId: brokerInstrument?.brokerId,
      brokerInstanceId: brokerInstrument?.brokerInstanceId, instrument: brokerInstrument },
    expiration: expiration ?? undefined, forceRefresh: force, signal: abort.signal });
  }, [underlying, exchange, expiration, brokerInstrument]);
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
  const storedPosition = stored?.symbol === underlying && (!exchange || stored.exchange === exchange) ? stored : seeded.value;
  // Following the market marks the position to the live spot and each leg's
  // live midpoint on every applied quote batch. A spot typed on the command
  // line is a what-if and stays; a frozen or screenshot scenario never moves.
  const liveStreaming = useLiveStreamingSetting();
  const [followState, setFollow] = usePluginPaneState<boolean | null>("followMarket", null);
  const follow = !frozen && !frozenMarket && (followState ?? !(settings.spot != null && settings.spot !== "" && typeof settings.seedLeg !== "string"));
  const legSymbols = useMemo(() => new Map((storedPosition?.legs ?? []).flatMap((leg) => {
    const symbol = scenarioLegContractSymbol(underlying, leg, market?.chain);
    return symbol ? [[leg.id, symbol] as const] : [];
  })), [storedPosition?.legs, underlying, market?.chain]);
  // Only the underlying and the position's own legs: the options stream budget is shared.
  const liveTargets = useMemo<QuoteSubscriptionTarget[]>(() => !follow || !underlying || !storedPosition ? [] : [
    { symbol: underlying, exchange: exchange ?? "", route: "provider", surface: "options", visible: true, selected: true, weight: 90 },
    ...[...new Set(legSymbols.values())].map((symbol) => ({ symbol, exchange: OPTIONS_QUOTE_EXCHANGE, surface: "options" as const,
      visible: true, weight: 90 })),
  ], [follow, underlying, exchange, !!storedPosition, legSymbols]);
  const { entries: liveEntries, freshnessNow, subscriptionStartedAt } = useLiveQuoteEntries(liveTargets, { liveStreaming });
  const live = useMemo(() => {
    if (!follow || !storedPosition) return null;
    const spotQuote = resolveEntryData(liveEntries.get(buildQuoteKey({ symbol: underlying, exchange: exchange ?? "" })));
    if (!spotQuote || spotQuote.stale || !(spotQuote.price > 0) || !Number.isFinite(spotQuote.price)
      || (spotQuote.currency && storedPosition.currency !== UNKNOWN_CURRENCY && spotQuote.currency !== storedPosition.currency)) return null;
    const freshness = { now: Math.max(freshnessNow, Date.now()), subscriptionStartedAt };
    const mids = new Map<string, number>();
    const quotes = new Map<string, HedgeQuote>();
    let delayed = spotQuote.dataSource !== "live";
    for (const [id, symbol] of legSymbols) {
      const quote = freshOptionQuote(liveEntries.get(buildOptionQuoteKey(symbol)), freshness);
      const mid = quote && quote.bid != null && quote.ask != null ? optionMid({ bid: quote.bid, ask: quote.ask }) : null;
      if (mid == null) continue;
      mids.set(id, mid);
      quotes.set(id, { bid: quote!.bid!, ask: quote!.ask! });
      delayed ||= quote!.dataSource !== "live";
    }
    return { position: liveScenarioPosition(storedPosition, spotQuote.price, Date.now(), mids), quotes,
      observedAt: spotQuote.lastUpdated, basis: delayed ? "delayed" : "real-time", session: extendedSession(spotQuote) };
  }, [follow, storedPosition, liveEntries, underlying, exchange, legSymbols, freshnessNow, subscriptionStartedAt]);
  const position = live?.position ?? storedPosition;
  const [controlState, setControls] = usePluginPaneState<ScenarioControls | null>("controls", null);
  const baseControls = useMemo(() => {
    try { return { value: position ? scenarioControlsFromSettings(settings, position) : null, error: null }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [settings, position]);
  const chosenControls = controlState ?? baseControls.value;
  // A scenario date the live origin has passed is now, not an error.
  const liveAsOf = live?.position.asOf ?? null;
  const controls = useMemo(() => liveAsOf != null && chosenControls
    ? { ...chosenControls, date: Math.max(chosenControls.date, liveAsOf) } : chosenControls, [chosenControls, liveAsOf]);
  const result = useMemo(() => {
    if (frozen) return { scenario: frozen, error: null };
    if (!controlState && baseControls.error) return { scenario: null, error: baseControls.error };
    if (!position?.legs.length) return { scenario: null, error: seeded.error };
    try { return { scenario: buildScenario(position, controls ?? {}), error: null }; }
    catch (error) { return { scenario: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [frozen, position, controls, seeded.error, controlState, baseControls.error]);
  const scenario = result.scenario;
  const error = localError ?? result.error;
  // A cash-secured put reads the earnings calendar for whether a report falls before it expires.
  const assetData = useAssetData();
  const cspStrategy = settings.strategy === "csp";
  const earningsLoader = useCallback(() => loadNextEarningsDate(assetData, underlying), [assetData, underlying]);
  // A screenshot keeps the date its report read.
  const frozenEarnings = Object.hasOwn(settings, "scenarioEarningsDate");
  const earnings = useAsyncResource(cspStrategy && underlying && !frozenEarnings ? earningsLoader : null);
  const earningsDate = frozenEarnings ? settings.scenarioEarningsDate as string | null : earnings.data;
  // A position following the market is at the live print, which the footer names with its feed.
  const spotBasis = scenario && !live ? scenarioSpotBasis(settings, scenario.position, market) : null;
  const csp = useMemo(() => cspStrategy && scenario && !earnings.loading
    ? cashSecuredPut(scenario.position, live?.basis ?? spotBasis ?? "last price", earningsDate) : null,
  [cspStrategy, scenario, earnings.loading, earningsDate, live?.basis, spotBasis]);
  // A collar seeded, or one typed with the shares it hedges, as the report reads it.
  const collarStrategy = settings.strategy === "collar";
  const collar = useMemo(() => scenario && (collarStrategy || scenario.position.underlying)
    ? scenarioCollar(scenario.position, live?.basis ?? spotBasis ?? "last price") : null, [collarStrategy, scenario, live?.basis, spotBasis]);
  // A report or capture of the pane is dated as `fn OSA` dates the same position: by the underlying's quote, its delay and where its market stands.
  const inputsOnly = suppliedScenarioInputs(settings);
  useRemoteUiNode(scenario && (market || inputsOnly) ? { role: "report-freshness", label: "Scenario freshness",
    getMetadata: () => ({ ...scenarioFreshness(market, inputsOnly) }) } : null);
  // The session the position is valued in, when it is not the regular one: its spot is the market's print (not a typed what-if or a saved position's).
  const valuedSession = live ? live.session
    : market?.underlyingQuote && scenario?.position.asOf === market.underlyingQuote.lastUpdated && spotBasis !== "typed"
      ? extendedSession(market.underlyingQuote) : null;
  // The report's Hedge budget, from the same position and quotes; a live position sizes at its live quotes and spot.
  const hedge = useMemo(() => {
    if (!scenario) return { value: null, error: null };
    try {
      return { value: scenarioHedgeBudget(settings, scenario.position,
        live ? { chain: market?.chain, liveQuotes: live.quotes } : market), error: null };
    } catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [settings, scenario, market, live]);
  const baseline = (): ScenarioPosition => position ?? { symbol: underlying, exchange,
    currency: scenarioCurrency(settings.currency, market?.currency || ticker?.metadata.currency, exchange ?? market?.exchange),
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
    const yes = await confirmDialog(dialog, { closeOnClickOutside: false, title: "Remove leg?",
      body: `${selected.quantity > 0 ? "Buy" : "Sell"} ${Math.abs(selected.quantity)} ${selected.side} ${selected.strike}`, confirmLabel: "Remove" });
    if (yes) setPosition({ ...position, legs: position.legs.filter((leg) => leg.id !== selected.id) });
  };
  const loadSaved = async () => {
    const choices = saved.filter((entry) => entry.position.symbol === underlying && (!exchange || entry.position.exchange === exchange));
    if (!choices.length) { notify({ body: "No saved strategies for this ticker." }); return; }
    const id = await dialog.prompt<string>({ content: (ctx: PromptContext<string>) => <ChoiceDialog {...ctx} title="Load strategy"
      choices={choices.map((entry) => ({ id: entry.id, label: entry.name, detail: dateLabel(entry.position.asOf) }))} /> }).catch(() => "");
    const selected = choices.find((entry) => entry.id === id);
    // A saved strategy opens at its saved spot, date and vols; following the market is an explicit choice.
    if (selected) { setPosition(selected.position); setControls(selected.controls); setFollow(false); setLocalError(null); }
  };
  const save = (name: string) => {
    if (!scenario) return;
    setSaved((entries) => [...restoreSavedStrategies(entries).strategies, { id: crypto.randomUUID(), name, position: scenario.position, controls: scenario.controls }]);
    setDetail(null); notify({ body: `Saved ${name}`, type: "success" });
  };
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "strike", direction: "asc" });
  const [gridSort, setGridSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "spot", direction: "asc" });
  const [chainSort, setChainSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "strike", direction: "asc" });
  const [volText, setVolText] = useState(String((controls?.volShift ?? 0) * 100));
  const dateControl = useRef<SelectControl>(null);
  const chainExpiryControl = useRef<SelectControl>(null);
  const [volActive, setVolActive] = useState(false);
  useInputCapture(focused && volActive);
  useEffect(() => { if (!volActive) setVolText(String((controls?.volShift ?? 0) * 100)); }, [controls?.volShift, volActive]);
  // The vol field lives in the root bar; a detail hides it, so it must not keep the keyboard.
  useEffect(() => { if (detail) setVolActive(false); }, [detail]);
  const shiftVol = (text: string) => {
    if (!text.trim() || !Number.isFinite(Number(text)) || !scenario) return;
    setControls({ ...scenario.controls, volShift: Number(text) / 100 });
  };
  // Freezing keeps the marks shown at this moment as the scenario's inputs.
  const freeze = () => { if (live) setPosition(live.position); setFollow(false); };
  // With a broker that takes them, the position trades as one order: a
  // spread on the underlying's Trade tab, or one contract's own ticket. The
  // live mids, else the entry prices, say whether it opens for a debit or a credit.
  const { pinTicker } = usePluginTickerActions();
  const { getBrokerAdapter } = usePluginBrokerActions();
  const { brokerInstances } = usePaneAppConfig();
  const tradeIntent = useMemo(() => {
    const legs = position?.legs ?? [];
    if (frozen || !underlying || !legs.length || legs.length > MAX_STRATEGY_LEGS || legs.some((leg) => leg.multiplier !== 100 || !legSymbols.get(leg.id))) return null;
    const intent = strategyFromLegs(legs.map((leg) => {
      const quote = live?.quotes.get(leg.id);
      return { contractSymbol: legSymbols.get(leg.id)!, quantity: leg.quantity, price: quote ? optionMid(quote) ?? leg.price : leg.price };
    }));
    if (!intent) return null;
    const tradable = intent.legs.length === 1 ? brokerCanTrade(brokerInstances, getBrokerAdapter, intent.legs[0]!.contractSymbol, "OPT")
      : brokerCanTradeStrategy(brokerInstances, getBrokerAdapter, underlying, intent.legs.length);
    return tradable ? intent : null;
  }, [frozen, underlying, position?.legs, legSymbols, live?.quotes, brokerInstances, getBrokerAdapter]);
  const trade = () => {
    if (!tradeIntent) return;
    const [only] = tradeIntent.legs;
    if (tradeIntent.legs.length === 1 && only) {
      openTradeTicket({ pinTicker }, only.contractSymbol, { action: only.action, quantity: tradeIntent.quantity * only.ratio },
        { instrument: null, listing: { name: optionContractName(only.contractSymbol) ?? only.contractSymbol, exchange: "", currency: position?.currency ?? "USD", type: "OPT" } });
    } else openTradeTicket({ pinTicker }, symbol ?? underlying, tradeIntent);
  };
  const hints = detail === "chain" ? [{ id: "expiry", key: "d", label: "ate", onPress: () => chainExpiryControl.current?.open() }] : detail || volActive ? [] : [
    { id: "add", key: "a", label: "dd leg", onPress: addTyped },
    { id: "chain", key: "c", label: "hain", onPress: () => setDetail("chain") },
    { id: "inputs", key: "i", label: "nputs", onPress: () => setDetail("inputs") },
    ...(selected && tab === "legs" ? [{ id: "edit", key: "e", label: "dit", onPress: () => edit(selected) },
      { id: "remove", key: "x", label: "remove", title: "Remove", onPress: () => void remove() }] : []),
    ...(scenario ? [{ id: "date", key: "d", label: "ate", onPress: () => dateControl.current?.open() },
      { id: "vol", key: "v", label: "ol shift", onPress: () => setVolActive(true) },
      { id: "save", key: "s", label: "ave", onPress: () => setDetail("save") }] : []),
    { id: "load", key: "b", label: "rowse saved", onPress: () => void loadSaved() },
    ...(tradeIntent ? [{ id: "trade", key: "t", label: "rade", onPress: trade }] : []),
    ...(live ? [{ id: "follow", key: "f", label: "reeze", onPress: freeze }]
      : follow || frozen || frozenMarket || !storedPosition ? [] : [{ id: "follow", key: "f", label: "ollow market", onPress: () => setFollow(true) }]),
  ];
  const notices = [...new Set([...restored.warnings, ...(market?.warnings ?? []), ...(scenario?.warnings ?? []), ...(resource.error ? [resource.error] : [])])];
  usePaneNoticeFooter({ registrationId: "osa-notices", notices, focused, enabled: !detail || detail === "chain" });
  // Following the market solves every quoted leg's IV from its live midpoint anyway.
  const midLegs = live || !position ? 0 : position.legs.filter((leg) => leg.volatilitySource === "mid").length;
  // A seed starts at the spot its quote mids imply, so name the last print when it differs.
  const lastPrint = midLegs && (settings.spot == null || settings.spot === "") && market?.spot != null
    && money(market.spot) !== money(position!.spot)
    ? ` · ${(market.underlyingQuote ? extendedSession(market.underlyingQuote) : null) ?? "last"} ${money(market.spot)}` : "";
  const midVolatility = !midLegs ? "" : (midLegs === position!.legs.length ? " · IV from quote mid"
    : ` · IV from quote mid on ${midLegs} of ${position!.legs.length} legs`) + lastPrint;
  // The spot every figure is valued at, and when: the live print, the spot the quote mids imply, a typed what-if or the last price.
  // An extended-session print carries its own time in the stamp.
  const spotStamp = position && spotBasis && spotBasis !== "last price" ? scenarioSpotStamp(spotBasis, position.asOf) : null;
  const spotText = position ? `spot ${money(position.spot)}${spotStamp ? ` ${spotStamp}` : ""}` : "";
  const spotTimed = !!spotStamp && spotStamp !== spotBasis;
  // A narrow row keeps the spot and its time before the rest.
  const shortSpotText = position ? `spot ${money(position.spot)} · ${formatSpotTime(live?.observedAt ?? position.asOf)}` : "";
  usePaneFooter("osa", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading chain", tone: "muted" as const }] }] : []),
    ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ...(hedge.error ? [{ id: "hedge-error", parts: [{ text: hedge.error, tone: "warning" as const }] }] : []),
    ...(live ? splitDelayedStatus({ id: "asof", parts: [{ text: `${live.basis} · ${spotText} · ${new Date(live.observedAt).toISOString().slice(11, 19)} UTC`, tone: "muted" }],
      variants: [[{ text: shortSpotText, tone: "muted" }]] })
      : position ? [{ id: "asof", parts: [{ text: `${spotText}${spotTimed ? "" : ` · ${formatSpotTime(position.asOf)}`} · ${market?.source ? "market" : "input assumptions"}${midVolatility}`, tone: "muted" as const }],
        variants: [[{ text: shortSpotText, tone: "muted" as const }]] }] : []),
  ], hints }), [hints, position, market?.source, resource.loading, error, hedge.error, live?.basis, live?.observedAt, midVolatility, spotText, shortSpotText]);
  useScenarioEvidence({ scenario, view: tab, loading: !!resource.loading && !scenario, error: error ?? (snapshotErrors.join("; ") || null), notices });
  // A choice dialog (scenario date, saved strategies) owns the keys while open.
  const dialogOpen = useDialogState((state) => state.isOpen);
  // The footer binds the hint keys. While the vol field is open, Enter, Esc and
  // Tab commit it instead of reaching the pane stack or the next pane.
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || dialogOpen) return;
    if (volActive) {
      if (["escape", "tab", "enter", "return"].includes(event.name ?? "")) {
        event.preventDefault(); event.stopPropagation(); shiftVol(volText); setVolActive(false);
      }
      return;
    }
    if (detail && detail !== "chain" || event.targetEditable) return;
    if (isPlainKey(event, "r")) void resource.reload();
  }, { enabled: focused && !dialogOpen, phase: "before", scope: "osa-actions", allowEditable: true });
  // A detail covers the tabs, so they stop answering h/l until it closes.
  const tabsFocused = focused && !volActive && !detail;
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: setTab, focused: tabsFocused, dense: true });
  const risk = scenario?.expiryRisk;
  // Value and P&L add every contract; spot and entry prices are per share.
  const valueUnit = scenario ? `${currencyLabel(scenario.position.currency)} ${scenarioValueUnit(scenario.position)}` : "";
  const stats: StatItem[] = scenario ? [
    { id: "pnl", label: "P&L", value: money(scenario.valuation.pnl), detail: valueUnit,
      tone: cents(scenario.valuation.pnl) >= 0 ? "positive" : "negative" },
    // A spot other than the last price says what it is: the one the quote mids imply, or a typed what-if.
    { id: "spot", label: "Spot", value: money(scenario.position.spot),
      detail: spotBasis === "implied by option quotes" ? "per share, implied" : spotBasis === "typed" ? "per share, typed"
        : spotTimed ? `per share, ${spotStamp}` : "per share",
      // The band keeps its columns: the stamp's day, its time, then the stamp give way first.
      ...(spotTimed ? { detailVariants: [...scenarioSpotStampVariants(spotBasis!, scenario.position.asOf)
        .map((form) => `per share, ${form}`), "per share"] } : {}) },
    { id: "value", label: "Value", value: money(scenario.valuation.price), detail: valueUnit },
    { id: "max-profit", label: "Max profit", value: risk?.unlimitedProfit ? "Unlimited" : money(risk?.maxProfit ?? null) },
    { id: "max-loss", label: "Max loss", value: risk?.unlimitedLoss ? "Unlimited" : money(risk?.maxLoss ?? null) },
    { id: "breakevens", label: "Breakevens", value: risk?.breakevens.map(money).join(", ") || "--" },
    { id: "delta", label: "Delta", value: scenario.valuation.delta.toFixed(2) },
    { id: "gamma", label: "Gamma", value: scenario.valuation.gamma.toFixed(3) },
    { id: "theta", label: "Theta", value: money(scenario.valuation.thetaPerDay), detail: "per day" },
    { id: "vega", label: "Vega", value: money(scenario.valuation.vegaPerPoint), detail: "per pt" },
    { id: "rho", label: "Rho", value: money(scenario.valuation.rhoPerPoint), detail: "per pt" },
  ] : [];
  const hedgeItems = hedge.value ? hedgeStatItems(hedge.value) : [];
  const cspItems = csp ? cspStatItems(csp) : [];
  const collarItems = collar ? collarStatItems(collar) : [];
  // The query bar and the stat band sit above the content only once a scenario prices.
  const bodyHeight = Math.max(3, height - tabRows - (scenario ? 1 + statGridRows(stats, width) : 0)
    - (hedgeItems.length ? statGridRows(hedgeItems, width) : 0) - (cspItems.length ? statGridRows(cspItems, width) : 0)
    - (collarItems.length ? statGridRows(collarItems, width) : 0));
  const legColumns: DataTableColumn[] = [{ id: "quantity", label: "Contracts", width: 10, align: "right" },
    { id: "side", label: "Option", width: 7, align: "left" }, { id: "strike", label: "Strike", width: 11, align: "right" },
    { id: "expiration", label: "Expiry", width: 12, align: "left" }, { id: "price", label: "Entry / share", width: 14, align: "right" },
    { id: "volatility", label: "IV %", width: 9, align: "right" }, { id: "multiplier", label: "Units", width: 7, align: "right" }];
  const activeContent = scenario && tab === "payoff" ? <ScenarioPayoffChart scenario={scenario} width={width} height={bodyHeight} focused={tabsFocused} session={valuedSession} />
    : scenario && tab === "grid" ? <DataTableView focused={focused && !volActive} rootWidth={width}
      rootHeight={bodyHeight} items={scenario.grid.toSorted((a, b) => { const value = (row: typeof a) => gridSort.columnId === "spot" ? row.spot : gridSort.columnId === "move" ? row.move ?? 0 : row.values[Number(gridSort.columnId)] ?? 0; return (value(a) - value(b)) * (gridSort.direction === "asc" ? 1 : -1); })}
      sortColumnId={gridSort.columnId} sortDirection={gridSort.direction} onHeaderClick={(id) => {
        // The landmark column has no label and no order of its own.
        if (id === "mark") return;
        setGridSort((current) => nextHeaderSort(current, id));
      }}
      emptyStateTitle="No scenario values." getItemKey={(row) => `${row.landmark ?? "step"}:${row.spot}`}
      columns={[{ id: "spot", label: `Spot ${position?.currency ?? ""}`, width: 14, align: "right" }, { id: "move", label: "Move %", width: 10, align: "right" },
        { id: "mark", label: "", width: 10, align: "left" },
        ...scenario.dates.map((date, i) => ({ id: String(i), label: dateLabel(date).slice(5), width: 13, align: "right" as const }))]}
      renderCell={(row, column) => {
        const atSpot = row.move != null && Math.abs(row.move) < 1e-9;
        if (column.id === "spot") return { text: money(row.spot), color: row.landmark ? colors.warning : atSpot ? colors.textBright : colors.text };
        if (column.id === "move") return { text: row.move == null ? "--" : `${row.move > 0 ? "+" : ""}${(row.move * 100).toFixed(1)}`, color: colors.textMuted };
        if (column.id === "mark") return { text: row.landmark ?? (atSpot ? "spot" : ""), color: row.landmark ? colors.warning : colors.textMuted };
        const value = cents(row.values[Number(column.id)] ?? 0);
        // Shade by size so the profit zone and the wings read at a glance.
        const peak = Math.max(1, ...scenario.grid.flatMap((entry) => entry.values.map(Math.abs)));
        return { text: money(value), color: value >= 0 ? colors.positive : colors.negative,
          backgroundColor: blendHex(colors.bg, value >= 0 ? colors.positive : colors.negative, 0.06 + 0.3 * Math.min(1, Math.abs(value) / peak)) };
      }} selection={{ kind: "index", selectedIndex: gridIndex, onChange: setGridIndex }} />
    : <DataTableView<ScenarioLeg> focused={focused && !volActive} rootWidth={width} rootHeight={bodyHeight}
      items={(position?.legs ?? []).toSorted((a, b) => { const x = a[sort.columnId as keyof ScenarioLeg], y = b[sort.columnId as keyof ScenarioLeg]; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * (sort.direction === "asc" ? 1 : -1); })}
      sortColumnId={sort.columnId} sortDirection={sort.direction} onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id))}
      emptyStateTitle="No position legs." columns={legColumns} getItemKey={(leg) => leg.id}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (leg) => leg.id, onChange: (id) => setSelectedId(id) }}
      onActivate={edit} renderCell={(leg, column) => ({ text: column.id === "expiration" ? dateLabel(leg.expiration * 1000)
        : column.id === "volatility" ? (leg.volatility * 100).toFixed(2)
        : column.id === "price" || column.id === "strike" ? money(leg[column.id])
        : String(leg[column.id as keyof ScenarioLeg]), color: column.id === "quantity" ? leg.quantity > 0 ? colors.positive : colors.negative : colors.text })} />;
  const root = <>
    {tabStrip}
    {scenario && <>
      <QueryBar
        width={width}
        filters={[
          { id: "date", label: "Scenario date", controlRef: dateControl, value: String(scenario.controls.date),
            options: [...new Set([...scenario.dates, scenario.controls.date])].sort((a, b) => a - b)
              .map((date) => ({ value: String(date), label: `${dateLabel(date)} +${((date - scenario.position.asOf) / 86_400_000).toFixed(1)}d` })),
            onChange: (value: string) => setControls({ ...scenario.controls, date: Number(value) }) },
          // No shift reads as the "0" placeholder, so the field offers its reset only once there is a shift.
          { id: "vol", kind: "text", label: "Vol shift (pts)", width: 12, placeholder: "0", debounceMs: 0,
            value: !volActive && volText === "0" ? "" : volText, focused, active: volActive,
            onActiveChange: (active: boolean) => { if (!active) shiftVol(volText); setVolActive(active); },
            onChange: (value: string) => { setVolText(value); shiftVol(value.trim() ? value : "0"); } },
        ]}
      />
      <StatGrid items={stats} width={width} />
      {hedgeItems.length > 0 && <StatGrid items={hedgeItems} width={width} />}
      {cspItems.length > 0 && <StatGrid items={cspItems} width={width} />}
      {collarItems.length > 0 && <StatGrid items={collarItems} width={width} />}
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
      <DataTableView focused={focused} rootWidth={width} rootHeight={Math.max(3, height - 2)} items={chainRows.toSorted((a, b) => { const value = (row: typeof a) => chainSort.columnId === "iv" ? row.impliedVolatility : chainSort.columnId === "oi" ? row.openInterest ?? 0 : row[chainSort.columnId as "side" | "strike" | "bid" | "ask"]; const x = value(a), y = value(b); return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * (chainSort.direction === "asc" ? 1 : -1); })}
        sortColumnId={chainSort.columnId} sortDirection={chainSort.direction} onHeaderClick={(id) => setChainSort((current) => nextHeaderSort(current, id))}
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
          // A typed volatility is an assumption: the scenario stops following the market.
          if (live && Math.abs(leg.volatility - editingLeg.volatility) > 1e-12) setFollow(false);
          const current = baseline();
          const legs = current.legs.some((entry) => entry.id === leg.id) ? current.legs.map((entry) => entry.id === leg.id ? leg : entry) : [...current.legs, leg];
          setPosition({ ...current, legs }); setSelectedId(leg.id); setDetail(null); setEditingLeg(null); setLocalError(null);
        }} /> : detail === "save" ? <ScenarioSaveForm focused={focused} onSave={save} onCancel={() => { setDetail(null); setEditingLeg(null); }} />
        : detail === "inputs" ? <ScenarioInputsForm position={baseline()} controls={controls} focused={focused} width={width}
          onCancel={() => { setDetail(null); setEditingLeg(null); }} onSave={(position, controls) => {
            // A typed spot is a what-if: the scenario stops following the market.
            if (live && Math.abs(position.spot - live.position.spot) > 1e-9) setFollow(false);
            setPosition(position); setControls(controls); if (editingLeg && !Number.isFinite(editingLeg.strike)) setEditingLeg({ ...editingLeg, strike: position.spot }); setDetail(editingLeg ? "leg" : null); setLocalError(null); }} /> : null} />
  </Box>;
}
