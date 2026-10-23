import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DataTableView, PaneStatusBody, QueryBar, usePaneFooter, usePaneNoticeFooter, type DataTableColumn, type DataTableKeyEvent } from "../../../components";
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
import { cspScreenNotes, cspScreenReportRow, type CspScreenReportRow } from "./csp-screen-headless";
import { CSP_SCREEN_DEFAULTS, CSP_SCREEN_LIMIT, cspScreenCriteriaText, cspTargetDate, loadCspScreen, readCspScreenCriteria, type CspScreenRow } from "./csp-screen";
import { formatHedgePrice } from "./hedge";

type ScreenRow = CspScreenReportRow & { source: CspScreenRow };

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

const DELTA_OPTIONS = ["0.10", "0.15", "0.20", "0.25", "0.30", "0.35", "0.40", "0.50"];
const DAYS_OPTIONS = ["7", "14", "21", "30", "45", "60", "90"];
const SYMBOLS_FIELD_WIDTH = 24;
/** Symbols apply once typing pauses, so a half-typed ticker does not start a screen. */
const SYMBOLS_DEBOUNCE_MS = 700;

const symbolList = (text: string) => [...new Set(text.split(/[\s,;]+/).map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
const percentText = (value: unknown, digits: number) => typeof value === "number" ? `${value.toFixed(digits)}%` : "--";
const priceText = (value: unknown) => typeof value === "number" ? formatHedgePrice(value) : "--";
/** A column's value to sort on: earnings by date, a flag as a number. */
function sortValue(row: CspScreenReportRow, columnId: string): string | number | null {
  if (columnId === "earnings") return row.earningsDate;
  const value = row[columnId as keyof CspScreenReportRow];
  return typeof value === "boolean" ? Number(value) : value;
}
/** A select's options with the current value kept when it is not a preset (a delta typed on the command line). */
const withCurrent = (presets: readonly string[], current: string, label: (value: string) => string) =>
  [...new Set([...presets, current])].sort((a, b) => Number(a) - Number(b)).map((value) => ({ value, label: label(value) }));

export function CspScreenPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const [symbolsText, setSymbolsText] = usePaneSettingValue<string>("symbols", "");
  const [delta, setDelta] = usePaneSettingValue<string | number>("delta", "");
  const [days, setDays] = usePaneSettingValue<string | number>("days", "");
  const [expiration, setExpiration] = usePaneSettingValue<string | number>("expiration", "");
  const [maxSpread] = usePaneSettingValue<string | number>("maxSpread", "");
  const [symbolsActive, setSymbolsActive] = useState(false);
  const { createPaneFromTemplate } = usePluginAppActions();
  const assetData = useAssetData();
  const typed = useMemo(() => symbolList(String(symbolsText ?? "")), [symbolsText]);
  // The screen reads the first names it can rank; the footer names the rest.
  const symbols = useMemo(() => typed.slice(0, CSP_SCREEN_LIMIT), [typed]);
  const leftOut = typed.slice(CSP_SCREEN_LIMIT);
  const criteria = useMemo(() => {
    try { return { value: readCspScreenCriteria({ delta, days, expiration, maxSpread }), error: null }; }
    catch (error) { return { value: null, error: error instanceof Error ? error.message : String(error) }; }
  }, [delta, days, expiration, maxSpread]);
  const controller = useRef<AbortController | null>(null);
  const key = JSON.stringify([symbols, criteria.value]);
  const loader = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    return loadCspScreen(symbols.map((symbol) => parsePublicTickerKey(symbol)), criteria.value!,
      { scenario: createScenarioDependencies(), earnings: assetData }, current.signal);
  }, [key, assetData]);
  const resource = useAsyncResource(symbols.length && criteria.value ? loader : null);
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(resource.updatedAt, resource.load);
  const [sort, setSort] = useState<{ columnId: string; direction: SortDirection }>({ columnId: "rank", direction: "asc" });
  const rows = useMemo<ScreenRow[]>(() => {
    const flat = (resource.data?.rows ?? []).map((row) => ({ ...cspScreenReportRow(row), source: row }));
    // Unranked names stay under the ranked ones whichever way rank sorts.
    return flat.sort((left, right) => sort.columnId === "rank"
      ? compareSortValues(left.rank ?? Number.POSITIVE_INFINITY, right.rank ?? Number.POSITIVE_INFINITY, sort.direction)
      : compareSortValues(sortValue(left, sort.columnId), sortValue(right, sort.columnId), sort.direction));
  }, [resource.data, sort]);
  const [selected, setSelected] = useState<string | null>(null);
  const screen = resource.data;
  const notices = [criteria.error, resource.data ? null : resource.error,
    leftOut.length ? `Ranks the first ${CSP_SCREEN_LIMIT} symbols; ${leftOut.length} left out: ${leftOut.join(", ")}` : null,
    ...(screen?.ivRankError ? [`IV rank unavailable: ${screen.ivRankError}`] : []),
    ...(screen?.rows ?? []).flatMap((row) => row.note ? [`${row.symbol}: ${row.note}`] : []),
    ...(screen ? cspScreenNotes(screen).slice(1) : [])].filter((value): value is string => !!value);
  usePaneNoticeFooter({ registrationId: "csp-screen-notices", notices, focused });
  // The bar names the delta and the expiry; the footer says only what changes.
  usePaneFooter("csp-screen", () => ({ info: [
    ...(resource.loading ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
  ] }), [resource.loading]);
  const criteriaText = criteria.value ? cspScreenCriteriaText(criteria.value, Date.now()) : "";
  // Enter opens the name's put in OSA, at the strike and expiry the screen read.
  const openScenario = (row: ScreenRow) => {
    const csp = row.source.csp;
    if (!csp) return;
    createPaneFromTemplate("options-scenario-pane", { symbol: row.symbol, values: { strategy: "csp", strike: String(csp.strike), expiration: csp.expiry } });
  };
  const handleKey = (event: DataTableKeyEvent): boolean => {
    if (event.ctrl || event.alt || event.meta || event.name !== "r") return false;
    void resource.reload();
    event.preventDefault?.(); event.stopPropagation?.(); return true;
  };
  const cell = (row: ScreenRow, id: string): { text: string; color?: string } => {
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
  const deltaValue = criteria.value ? criteria.value.delta.toFixed(2) : CSP_SCREEN_DEFAULTS.delta.toFixed(2);
  const daysValue = String(criteria.value?.days ?? CSP_SCREEN_DEFAULTS.days);
  // A date typed on the command line is the expiry's choice until a number of days is picked.
  const typedDate = criteria.value?.expiration != null ? cspTargetDate(criteria.value, Date.now()) : null;
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <QueryBar width={width} filters={[
      { id: "symbols", kind: "text" as const, label: "Symbols", value: String(symbolsText ?? ""), placeholder: "JPM, GS, KO",
        width: SYMBOLS_FIELD_WIDTH, debounceMs: SYMBOLS_DEBOUNCE_MS, focused, active: symbolsActive, onActiveChange: setSymbolsActive,
        onChange: setSymbolsText },
      { id: "delta", label: "Delta", value: deltaValue, defaultValue: CSP_SCREEN_DEFAULTS.delta.toFixed(2),
        options: withCurrent(DELTA_OPTIONS, deltaValue, (value) => value), onChange: (value: string) => setDelta(value) },
      { id: "expiry", label: "Expiry", value: typedDate ?? daysValue, defaultValue: String(CSP_SCREEN_DEFAULTS.days),
        options: [...withCurrent(DAYS_OPTIONS, daysValue, (value) => `${value} days`), ...(typedDate ? [{ value: typedDate, label: typedDate }] : [])],
        onChange: (value: string) => { if (value === typedDate) return; setExpiration(""); setDays(value); } },
    ]} />
    <PaneStatusBody subject="cash-secured puts" loading={resource.loading && !resource.data}
      error={criteria.error && !criteria.value ? criteria.error : !resource.data ? resource.error : null}>
      <DataTableView<ScreenRow> focused={focused && !symbolsActive} columns={COLUMNS} items={rows} rootWidth={width}
        rootHeight={Math.max(2, height - 1)}
        getItemKey={(row) => row.symbol} sortColumnId={sort.columnId} sortDirection={sort.direction}
        emptyStateTitle={symbols.length ? "No puts to rank." : "Type symbols to rank their cash-secured puts."}
        onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id, { firstDirection: id === "rank" || id === "symbol" ? "asc" : "desc" }))}
        selection={{ kind: "id", selectedId: selected ?? rows[0]?.symbol ?? "", getId: (row) => row.symbol, onChange: (id) => setSelected(id) }}
        onActivate={openScenario} onRootKeyDown={handleKey}
        getExportMetadata={() => [["puts", criteriaText || undefined], ["ranked by", "annualised yield on cash at the bid"],
          ["wide", criteria.value ? `spread over ${criteria.value.maxSpreadPercent}% of the mid` : undefined]]}
        renderCell={(row, column) => cell(row, column.id)} />
    </PaneStatusBody>
  </Box>;
}
