import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableView, PaneStatusBody, QueryBar, usePaneFooter, usePaneNoticeFooter, usePaneTabs, type DataTableCell, type DataTableColumn, type DataTableKeyEvent,
  type QueryBarFilter,
} from "../../../components";
import { dropColumnsToFit } from "../../../components/ui/table-layout";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneSettingValue, usePluginAppActions } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { parsePublicTickerKey } from "../../../utils/exchanges";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { useAssetData } from "../../runtime";
import { createScenarioDependencies } from "./client";
import {
  cspScreenNotes, cspScreenReportRow, rewardRiskText, STRATEGY_MONEY_UNIT, strategyScreenReportRow, type CspScreenReportRow,
  type StrategyScreenReportRow,
} from "./csp-screen-headless";
import { CSP_SCREEN_DEFAULTS, CSP_SCREEN_LIMIT, cspScreenCriteriaText, cspTargetDate, loadCspScreen, readCspScreenCriteria, type CspScreenRow } from "./csp-screen";
import { formatHedgePrice } from "./hedge";
import {
  loadStrategyScreen, readStrategyFamily, readStrategyScreenCriteria, STRATEGY_TABS, strategyFamilyDef, strategyRankedBy,
  strategyScreenCriteriaText, tabFamilies, type ScreenFamily, type StrategyFamily, type StrategyScreenRow, type StrategyTab,
} from "./strategy-screen";

type ScreenRow = CspScreenReportRow & { source: CspScreenRow };
type TradeRow = StrategyScreenReportRow & { source: StrategyScreenRow };

const COLUMNS: DataTableColumn[] = [
  { id: "rank", label: "#", width: 3, align: "right" },
  { id: "symbol", label: "Symbol", width: 7, align: "left" },
  { id: "expiry", label: "Expiry", width: 10, align: "right" },
  { id: "days", label: "DTE", width: 4, align: "right" },
  { id: "strike", label: "Strike", width: 8, align: "right" },
  { id: "bid", label: "Bid", width: 7, align: "right" },
  { id: "ask", label: "Ask", width: 7, align: "right" },
  { id: "spread", label: "Spread", width: 11, align: "right" },
  { id: "delta", label: "Delta", width: 6, align: "right" },
  { id: "otm", label: "OTM", width: 6, align: "right" },
  { id: "midYield", label: "Mid yield/yr", width: 12, align: "right" },
  { id: "bidYield", label: "Bid yield/yr", width: 12, align: "right" },
  { id: "ivRank", label: "IVR", width: 4, align: "right" },
  { id: "earnings", label: "Earnings", width: 17, align: "left" },
];

/** At a narrow width the put screen keeps the put, its yield and its risks; its expiry and the mid's yield give way first. */
const PUT_DROP_ORDER = ["midYield", "expiry", "otm", "ask", "bid", "rank", "delta"];

/** The Trade column fits the longest trade listed, so a condor's bought wings show beside its sold legs. */
const TRADE_WIDTH = { min: 14, max: 40 };
const tradeWidth = (rows: readonly { trade: string | null }[]) =>
  Math.min(TRADE_WIDTH.max, Math.max(TRADE_WIDTH.min, ...rows.map((row) => row.trade?.length ?? 0)));

/**
 * A family's columns. DTE dates the trade (a calendar's bought expiry is in
 * its words). Money is per contract, said once in the bar. An income trade
 * reads its annualised return, a debit trade its reward to risk.
 */
const tradeColumns = (strategy: ScreenFamily, tradeColumnWidth: number): DataTableColumn[] => {
  const credit = strategyFamilyDef(strategy).net === "credit";
  return [
    { id: "rank", label: "#", width: 3, align: "right" },
    { id: "symbol", label: "Symbol", width: 7, align: "left" },
    { id: "days", label: "DTE", width: 4, align: "right" },
    { id: "trade", label: "Trade", width: tradeColumnWidth, align: "left", flexGrow: 1 },
    { id: "net", label: credit ? "Credit" : "Debit", width: 8, align: "right", title: STRATEGY_MONEY_UNIT },
    { id: "maxGain", label: "Max gain", width: 9, align: "right", title: STRATEGY_MONEY_UNIT },
    { id: "maxLoss", label: "Max loss", width: 9, align: "right", title: STRATEGY_MONEY_UNIT },
    { id: "breakEven", label: "Break-even", width: 15, align: "right" },
    { id: "pop", label: "PoP", width: 4, align: "right" },
    credit ? { id: "returnPerYear", label: "Return/yr", width: 9, align: "right" }
      : { id: "rewardRisk", label: "Reward/risk", width: 9, align: "right", title: "Max gain over max loss" },
    { id: "ivRank", label: "IVR", width: 4, align: "right" },
    { id: "spread", label: "Spread", width: 11, align: "right" },
    { id: "earnings", label: "Earnings", width: 13, align: "left" },
  ];
};
/**
 * What a narrow pane gives up first: the max gain or loss that repeats the
 * credit or debit, then the break-evens, the rank, the other max, the
 * earnings flag and the spread. Symbol, DTE, trade, credit or debit, PoP,
 * the return and IV rank stay at every width.
 */
const tradeDropOrder = (strategy: ScreenFamily) => strategyFamilyDef(strategy).net === "credit"
  ? ["maxGain", "breakEven", "rank", "maxLoss", "earnings", "spread"]
  : ["maxLoss", "breakEven", "rank", "maxGain", "earnings", "spread"];

const DELTA_OPTIONS = ["0.10", "0.15", "0.20", "0.25", "0.30", "0.35", "0.40", "0.50"];
const WING_OPTIONS = ["0.05", "0.10", "0.15", "0.20", "0.25", "0.30", "0.35", "0.40"];
const DAYS_OPTIONS = ["7", "14", "21", "30", "45", "60", "90"];
const SYMBOLS_FIELD_WIDTH = 24;
/** Symbols apply once typing pauses, so a half-typed ticker does not start a screen. */
const SYMBOLS_DEBOUNCE_MS = 700;

const symbolList = (text: string) => [...new Set(text.split(/[\s,;]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
const percentText = (value: unknown, digits: number) => typeof value === "number" ? `${value.toFixed(digits)}%` : "--";
const priceText = (value: unknown) => typeof value === "number" ? formatHedgePrice(value) : "--";
const moneyText = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const riskText = (value: number | null, unlimited: boolean) => value != null ? moneyText(value) : unlimited ? "unlimited" : "--";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** `before Oct 28`: the flag and the date without its year, which the next report never needs. */
const earningsCell = (row: { earningsDate: string | null; earningsBeforeExpiry: boolean | null; earnings: string }) => {
  const date = row.earningsDate;
  if (!date || row.earningsBeforeExpiry == null) return row.earnings;
  return `${row.earningsBeforeExpiry ? "before" : "after"} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;
};
/** A column's value to sort on: earnings by date, a flag as a number, an unlimited gain or loss above every limit. */
function sortValue(row: Record<string, unknown>, columnId: string): string | number | null {
  if (columnId === "earnings") return typeof row.earningsDate === "string" ? row.earningsDate : null;
  if ((columnId === "maxGain" || columnId === "rewardRisk") && row.unlimited === "gain") return Number.POSITIVE_INFINITY;
  if (columnId === "maxLoss" && row.unlimited === "loss") return Number.POSITIVE_INFINITY;
  const value = row[columnId];
  return typeof value === "boolean" ? Number(value) : typeof value === "number" || typeof value === "string" ? value : null;
}
/** A select's options with the current value kept when it is not a preset (a delta typed on the command line). */
const withCurrent = (presets: readonly string[], current: string, label: (value: string) => string) =>
  [...new Set([...presets, current])].sort((a, b) => Number(a) - Number(b)).map((value) => ({ value, label: label(value) }));

/** OSA's typed legs for a trade (`call,105,2026-11-20,-1,1.64,28.1`), each at its entry price and IV. */
const osaLegs = (row: StrategyScreenRow) => row.trade!.position.legs.map((leg) => [leg.side, leg.strike, new Date(leg.expiration * 1000).toISOString().slice(0, 10),
  leg.quantity, Number(leg.price.toFixed(6)), Number((leg.volatility * 100).toFixed(4)), leg.multiplier].join(",")).join(";");

export function CspScreenPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const [symbolsText, setSymbolsText] = usePaneSettingValue<string>("symbols", "");
  const [strategySetting, setStrategySetting] = usePaneSettingValue<string>("strategy", "");
  const [delta, setDelta] = usePaneSettingValue<string | number>("delta", "");
  const [wingDelta, setWingDelta] = usePaneSettingValue<string | number>("wingDelta", "");
  const [days, setDays] = usePaneSettingValue<string | number>("days", "");
  const [expiration, setExpiration] = usePaneSettingValue<string | number>("expiration", "");
  const [maxSpread] = usePaneSettingValue<string | number>("maxSpread", "");
  const [symbolsActive, setSymbolsActive] = useState(false);
  const { createPaneFromTemplate } = usePluginAppActions();
  const assetData = useAssetData();
  const strategy = useMemo((): StrategyFamily => {
    try { return readStrategyFamily(strategySetting); } catch { /* Intentional ignore: an unknown saved strategy opens the cash-secured put screen. */ return "csp"; }
  }, [strategySetting]);
  const family = strategyFamilyDef(strategy);
  // Each strategy opens at its own deltas; the names and the expiry carry over.
  const chooseStrategy = (next: StrategyFamily) => {
    if (next === strategy) return;
    setStrategySetting(next === "csp" ? "" : next);
    setDelta("");
    setWingDelta("");
  };
  const { strip: tabStrip, rows: tabRows } = usePaneTabs({ tabs: STRATEGY_TABS.map((tab) => ({ ...tab })), activeValue: family.tab,
    onSelect: (tab) => chooseStrategy(tabFamilies(tab as StrategyTab)[0]!.id), focused, dense: true });
  const typed = useMemo(() => symbolList(String(symbolsText ?? "")), [symbolsText]);
  // The screen reads the first names it can rank; the footer names the rest.
  const symbols = useMemo(() => typed.slice(0, CSP_SCREEN_LIMIT), [typed]);
  const leftOut = typed.slice(CSP_SCREEN_LIMIT);
  const criteria = useMemo(() => {
    try {
      const options = { delta, wingDelta, days, expiration, maxSpread };
      if (strategy === "csp") return { value: readCspScreenCriteria(options), trade: null, error: null };
      return { value: null, trade: readStrategyScreenCriteria(strategy, options), error: null };
    } catch (error) { return { value: null, trade: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [strategy, delta, wingDelta, days, expiration, maxSpread]);
  const ready = criteria.value ?? criteria.trade;
  const controller = useRef<AbortController | null>(null);
  const key = JSON.stringify([symbols, strategy, ready]);
  const loader = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const instruments = symbols.map((symbol) => parsePublicTickerKey(symbol));
    const dependencies = { scenario: createScenarioDependencies(), earnings: assetData };
    if (criteria.trade) return { kind: "trade" as const, screen: await loadStrategyScreen(instruments, criteria.trade, dependencies, current.signal) };
    return { kind: "csp" as const, screen: await loadCspScreen(instruments, criteria.value!, dependencies, current.signal) };
  }, [key, assetData]);
  const resource = useAsyncResource(symbols.length && ready ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "rank", direction: "asc" });
  // A strategy's answer shows only under its own tab: the last one stays until the next has loaded only for the same strategy.
  const data = resource.data && (resource.data.kind === "csp") === (strategy === "csp")
    && (resource.data.kind === "csp" || resource.data.screen.criteria.strategy === strategy) ? resource.data : null;
  const order = useCallback(<Row extends { rank: number | null } & Record<string, unknown>>(flat: Row[]) => flat.sort((left, right) => sort.columnId === "rank"
    // Unranked names stay under the ranked ones whichever way rank sorts.
    ? compareSortValues(left.rank ?? Number.POSITIVE_INFINITY, right.rank ?? Number.POSITIVE_INFINITY, sort.direction)
    : compareSortValues(sortValue(left, sort.columnId), sortValue(right, sort.columnId), sort.direction)), [sort]);
  const putRows = useMemo<ScreenRow[]>(() => data?.kind !== "csp" ? []
    : order(data.screen.rows.map((row) => ({ ...cspScreenReportRow(row), source: row }))), [data, order]);
  const tradeRows = useMemo<TradeRow[]>(() => data?.kind !== "trade" ? []
    : order(data.screen.rows.map((row) => ({ ...strategyScreenReportRow(row), source: row }))), [data, order]);
  const [selected, setSelected] = useState<string | null>(null);
  const screen = data?.screen;
  const rankedBy = strategy === "csp" ? undefined : strategyRankedBy(strategy);
  const notices = [criteria.error, data ? null : resource.error,
    leftOut.length ? `Ranks the first ${CSP_SCREEN_LIMIT} symbols; ${leftOut.length} left out: ${leftOut.join(", ")}` : null,
    ...(screen?.ivRankError ? [`IV rank unavailable: ${screen.ivRankError}`] : []),
    ...(screen?.rows ?? []).flatMap((row) => row.note ? [`${row.symbol}: ${row.note}`] : []),
    ...(screen ? cspScreenNotes(screen, rankedBy).slice(1) : [])].filter((value): value is string => !!value);
  usePaneNoticeFooter({ registrationId: "csp-screen-notices", notices, focused });
  // The bar names the delta and the expiry; the footer says only what changes.
  usePaneFooter("csp-screen", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
  ] }), [resource.loading]);
  const now = Date.now();
  const criteriaText = criteria.value ? cspScreenCriteriaText(criteria.value, now) : criteria.trade ? strategyScreenCriteriaText(criteria.trade, now) : "";
  // Enter opens the name's trade in OSA: the put at the strike and expiry the screen read, any other trade as its legs.
  const openScenario = (row: ScreenRow | TradeRow) => {
    if ("csp" in row.source) {
      const csp = row.source.csp;
      if (!csp) return;
      createPaneFromTemplate("options-scenario-pane", { symbol: row.symbol, values: { strategy: "csp", strike: String(csp.strike), expiration: csp.expiry } });
      return;
    }
    const trade = row.source.trade;
    if (!trade) return;
    createPaneFromTemplate("options-scenario-pane", { symbol: row.symbol, values: { legs: osaLegs(row.source),
      ...(trade.position.underlying ? { shares: String(trade.position.underlying.quantity) } : {}) } });
  };
  const handleKey = (event: DataTableKeyEvent): boolean => {
    if (event.ctrl || event.alt || event.meta || event.name !== "r") return false;
    void resource.reload();
    event.preventDefault?.(); event.stopPropagation?.(); return true;
  };
  const putCell = (row: ScreenRow, id: string): { text: string; color?: string } => {
    switch (id) {
      case "rank": return { text: row.rank == null ? "" : String(row.rank), color: colors.textDim };
      case "symbol": return { text: row.symbol, color: colors.textBright };
      case "expiry": return { text: String(row.expiry ?? "--"), color: colors.textDim };
      case "days": return { text: row.days == null ? "--" : String(row.days) };
      case "strike": return { text: row.strike == null ? "--" : String(row.strike) };
      case "bid": return { text: priceText(row.bid) };
      case "ask": return { text: priceText(row.ask) };
      case "spread": return { text: `${percentText(row.spread, 1)}${row.wide ? " wide" : ""}`, color: row.wide ? colors.warning : undefined };
      case "delta": return { text: typeof row.delta === "number" ? row.delta.toFixed(2) : "--" };
      case "otm": return { text: percentText(row.otm, 1) };
      case "midYield": return { text: percentText(row.midYield, 2), color: colors.textDim };
      case "bidYield": return { text: percentText(row.bidYield, 2), color: colors.positive };
      case "ivRank": return { text: typeof row.ivRank === "number" ? row.ivRank.toFixed(0) : "--" };
      case "earnings": return { text: String(row.earnings), color: row.earningsBeforeExpiry === true ? colors.warning : colors.textDim };
      default: return { text: "" };
    }
  };
  const tradeCell = (row: TradeRow, id: string): DataTableCell => {
    switch (id) {
      case "rank": return { text: row.rank == null ? "" : String(row.rank), color: colors.textDim };
      case "symbol": return { text: row.symbol, color: colors.textBright };
      case "days": return { text: row.days == null ? "--" : String(row.days) };
      case "trade": return { text: row.trade ?? "--" };
      case "net": return { text: row.net == null ? "--" : moneyText(row.net) };
      case "maxGain": return { text: riskText(row.maxGain, row.unlimited === "gain") };
      case "maxLoss": return { text: riskText(row.maxLoss, row.unlimited === "loss") };
      case "breakEven": return { text: row.breakEvens };
      case "pop": return { text: percentText(row.pop, 0) };
      // A return above zero reads as a gain; none, or nothing to rank, stays neutral.
      case "returnPerYear": return { text: percentText(row.returnPerYear, 1), color: (row.returnPerYear ?? 0) > 0 ? colors.positive : undefined };
      case "rewardRisk": return { text: rewardRiskText(row.rewardRisk, row.unlimited), value: row.rewardRisk };
      case "ivRank": return { text: typeof row.ivRank === "number" ? row.ivRank.toFixed(0) : "--" };
      case "spread": return { text: `${percentText(row.spread, 1)}${row.wide ? " wide" : ""}`, color: row.wide ? colors.warning : undefined };
      case "earnings": return { text: earningsCell(row), value: row.earningsDate,
        color: row.earningsBeforeExpiry === true ? colors.warning : colors.textDim };
      default: return { text: "" };
    }
  };
  const familyDelta = family.delta ?? CSP_SCREEN_DEFAULTS.delta;
  const deltaValue = (criteria.value ?? criteria.trade)?.delta?.toFixed(2) ?? familyDelta.toFixed(2);
  const wingValue = criteria.trade?.wingDelta?.toFixed(2) ?? (family.wing != null ? family.wing.toFixed(2) : "");
  const defaultWing = family.wing == null ? "" : (family.wing < Number(deltaValue) ? family.wing : Number(deltaValue) / 2).toFixed(2);
  const daysValue = String(ready?.days ?? CSP_SCREEN_DEFAULTS.days);
  // A date typed on the command line is the expiry's choice until a number of days is picked.
  const typedDate = ready?.expiration != null ? cspTargetDate(ready, now) : null;
  const choices = tabFamilies(family.tab);
  const filters: QueryBarFilter[] = [
    { id: "symbols", kind: "text" as const, label: "Symbols", value: String(symbolsText ?? ""), placeholder: "JPM, GS, KO",
      width: SYMBOLS_FIELD_WIDTH, debounceMs: SYMBOLS_DEBOUNCE_MS, focused, active: symbolsActive, onActiveChange: setSymbolsActive,
      onChange: setSymbolsText },
    ...(choices.length > 1 ? [{ id: "variant", label: family.tab === "vertical" ? "Spread" : "Side", value: strategy,
      options: choices.map((choice) => ({ value: choice.id, label: choice.choice ?? choice.title })),
      onChange: (value: string) => chooseStrategy(value as ScreenFamily) }] : []),
    ...(family.delta != null ? [{ id: "delta", label: "Delta", value: deltaValue, defaultValue: familyDelta.toFixed(2),
      options: withCurrent(DELTA_OPTIONS, deltaValue, (value) => value), onChange: (value: string) => setDelta(value) }] : []),
    ...(family.wing != null ? [{ id: "wing", label: "Wing", value: wingValue, defaultValue: defaultWing,
      options: withCurrent(WING_OPTIONS.filter((value) => Number(value) < Number(deltaValue)), wingValue, (value) => value),
      onChange: (value: string) => setWingDelta(value) }] : []),
    { id: "expiry", label: "Expiry", value: typedDate ?? daysValue, defaultValue: String(CSP_SCREEN_DEFAULTS.days),
      options: [...withCurrent(DAYS_OPTIONS, daysValue, (value) => `${value} days`), ...(typedDate ? [{ value: typedDate, label: typedDate }] : [])],
      onChange: (value: string) => { if (value === typedDate) return; setExpiration(""); setDays(value); } },
  ];
  const subject = strategy === "csp" ? "cash-secured puts" : family.title.toLowerCase();
  const table = {
    focused: focused && !symbolsActive, rootWidth: width, rootHeight: Math.max(2, height - 1 - tabRows),
    getItemKey: (row: { symbol: string }) => row.symbol, sortColumnId: sort.columnId, sortDirection: sort.direction,
    emptyStateTitle: symbols.length ? `No ${strategy === "csp" ? "puts" : subject} to rank.` : `Type symbols to rank their ${subject}.`,
    onHeaderClick: (id: string) => setSort((current) => nextHeaderSort(current, id, { firstDirection: id === "rank" || id === "symbol" ? "asc" : "desc" })),
    onActivate: openScenario, onRootKeyDown: handleKey,
    getExportMetadata: (): Array<[string, string | undefined]> => [[strategy === "csp" ? "puts" : subject, criteriaText || undefined],
      ["ranked by", strategy === "csp" ? "annualised yield on cash at the bid" : rankedBy],
      ["wide", ready ? `spread over ${ready.maxSpreadPercent}% of the mid` : undefined],
      ...(strategy === "csp" ? [] : [["money", STRATEGY_MONEY_UNIT] as [string, string]])],
  };
  // Whole columns give way, least needed first, so nothing scrolls sideways; a vertical scrollbar takes a cell.
  const putColumns = useMemo(() => dropColumnsToFit(COLUMNS, width - 1, PUT_DROP_ORDER), [width]);
  const tradeColumnWidth = tradeWidth(tradeRows);
  const shownTradeColumns = useMemo(() => strategy === "csp" ? [] : dropColumnsToFit(tradeColumns(strategy, tradeColumnWidth), width - 1,
    tradeDropOrder(strategy)), [strategy, tradeColumnWidth, width]);
  const firstSymbol = (strategy === "csp" ? putRows : tradeRows)[0]?.symbol ?? "";
  const selection = { kind: "id" as const, selectedId: selected ?? firstSymbol, getId: (row: { symbol: string }) => row.symbol, onChange: (id: string) => setSelected(id) };
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    {tabStrip}
    <QueryBar width={width} filters={filters} meta={strategy === "csp" ? undefined : STRATEGY_MONEY_UNIT} />
    <PaneStatusBody subject={subject} loading={resource.loading && !data}
      error={criteria.error && !ready ? criteria.error : !data ? resource.error : null}>
      {strategy === "csp"
        ? <DataTableView<ScreenRow> {...table} columns={putColumns} items={putRows} selection={selection}
          renderCell={(row, column) => putCell(row, column.id)} />
        : <DataTableView<TradeRow> {...table} columns={shownTradeColumns} items={tradeRows} selection={selection}
          renderCell={(row, column) => tradeCell(row, column.id)} />}
    </PaneStatusBody>
  </Box>;
}
