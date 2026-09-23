import { useCallback, useMemo, useRef, useState } from "react";
import { Box, ScrollBox } from "../../../ui";
import { DataTableView, FieldGrid, KeyValueRow, Notice, QueryBar, Section, Tabs, usePaneHeaderTabs, usePaneNoticeFooter, type GridField, type SelectControl } from "../../../components";
import { usePaneSettingValue, usePaneStateValue, useShortcut } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadBondBenchmark } from "./client";
import { bondDraftFromOptions, calculateBond, type BondDraft } from "./model";

const TABS = [{ label: "Valuation", value: "valuation" }, { label: "Cash flows", value: "cashflows" }, { label: "Sensitivity", value: "sensitivity" }];
const MODES = [{ label: "Yield", value: "yield" }, { label: "Price", value: "price" }];
const FREQUENCIES = [{ label: "Annual", value: "1" }, { label: "Semiannual", value: "2" }, { label: "Quarterly", value: "4" }];
const CONVENTIONS = [{ label: "ACT/ACT ICMA", value: "act-act-icma" }, { label: "30/360 US", value: "30-360-us" }];
const FIELDS = ["settlement", "maturity", "coupon", "quote"] as const;
const FLOW_COLUMNS = [
  { id: "date", label: "Payment date", width: 14, align: "left" as const },
  { id: "amount", label: "Cash / 100", width: 13, align: "right" as const },
  { id: "presentValue", label: "PV / 100", width: 13, align: "right" as const },
];
const SHOCK_COLUMNS = [
  { id: "shiftBps", label: "Shift bp", width: 10, align: "right" as const },
  { id: "yieldPercent", label: "Yield %", width: 11, align: "right" as const },
  { id: "cleanPrice", label: "Clean / 100", width: 14, align: "right" as const },
  { id: "priceChange", label: "Change / 100", width: 14, align: "right" as const },
  { id: "returnPercent", label: "Return %", width: 12, align: "right" as const },
];
const loadBenchmark = () => loadBondBenchmark();
const fixed = (value: number | null | undefined, digits = 4) => value == null ? "-" : value.toFixed(digits);

export function BondCalculatorPane({ focused, width, height }: PaneProps) {
  const [settlement] = usePaneSettingValue<string | undefined>("settlement", undefined);
  const [maturity] = usePaneSettingValue<string | undefined>("maturity", undefined);
  const [coupon] = usePaneSettingValue<string | undefined>("coupon", undefined);
  const [yieldInput] = usePaneSettingValue<string | undefined>("yield", undefined);
  const [price] = usePaneSettingValue<string | undefined>("price", undefined);
  const [frequency] = usePaneSettingValue<string | undefined>("frequency", undefined);
  const [dayCount] = usePaneSettingValue<string | undefined>("dayCount", undefined);
  const [endOfMonth] = usePaneSettingValue<boolean | undefined>("endOfMonth", undefined);
  const [tab, setTab] = usePaneSettingValue("tab", "valuation");
  const seed = useMemo(() => bondDraftFromOptions({ settlement, maturity, coupon, yield: yieldInput, price, frequency, dayCount, endOfMonth }),
    [settlement, maturity, coupon, yieldInput, price, frequency, dayCount, endOfMonth]);
  const [draft, setDraft] = usePaneStateValue<BondDraft>("draft", seed);
  const [activeField, setActiveField] = useState<(typeof FIELDS)[number] | null>(null);
  const [flowRow, setFlowRow] = useState(0);
  const frequencyControl = useRef<SelectControl>(null);
  const conventionControl = useRef<SelectControl>(null);
  const { data, loading, error, updatedAt, load } = useAsyncResource(loadBenchmark);
  useAutoRefresh(updatedAt, load);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const update = useCallback((patch: Partial<BondDraft>) => {
    // Controlled native fields can echo an update during the same commit.
    // Preserve an atomic mode/quote change instead of replaying an older draft.
    if (Object.entries(patch).every(([key, value]) => draftRef.current[key as keyof BondDraft] === value)) return;
    const next = { ...draftRef.current, ...patch };
    draftRef.current = next;
    setDraft(next);
  }, [setDraft]);
  const evaluation = useMemo(() => {
    try { return { result: calculateBond(draft, data?.points), error: null }; }
    catch (failure) { return { result: null, error: failure instanceof Error ? failure.message : String(failure) }; }
  }, [draft, data]);
  const result = evaluation.result;
  const setMode = useCallback((mode: string) => {
    if (mode !== "yield" && mode !== "price") return;
    update({ mode, quote: result ? String(Number((mode === "yield" ? result.analytics.yieldPercent : result.analytics.cleanPrice).toPrecision(13))) : draft.quote });
  }, [result, draft.quote, update]);
  const selectTab = useCallback((value: string) => { setActiveField(null); setTab(value); }, [setTab]);
  const tabsInHeader = usePaneHeaderTabs({ tabs: TABS, activeValue: tab, onSelect: selectTab, focused: focused && !activeField });
  const tabRows = tabsInHeader ? 0 : 1;
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.ctrl || event.alt || event.meta || event.super) return;
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.name === "tab") {
      // Tab walks the fields once one is being edited and leaves them past
      // either end; with no field active it moves to the next pane as usual.
      if (tab !== "valuation" || !activeField) return;
      consume();
      setActiveField(FIELDS[FIELDS.indexOf(activeField) + (event.shift ? -1 : 1)] ?? null);
    } else if (event.name === "escape" && activeField) { consume(); setActiveField(null); }
    // Shifted letters are global chords (Shift+R refreshes everything).
    else if (event.targetEditable || event.shift) return;
    else if (event.name === "e") { consume(); setTab("valuation"); setActiveField("settlement"); }
    else if (event.name === "r") { consume(); void load(); }
    else if ((event.name === "j" || event.name === "k") && tab === "valuation") {
      consume();
      const index = activeField ? FIELDS.indexOf(activeField) : -1;
      setActiveField(FIELDS[(index + (event.name === "j" ? 1 : -1) + FIELDS.length) % FIELDS.length]!);
    }
    // The bar's conventions are one key each rather than stops in the Tab order,
    // where they would take focus without showing it.
    else if (tab === "valuation" && event.name === "m") { consume(); setMode(draft.mode === "yield" ? "price" : "yield"); }
    else if (tab === "valuation" && event.name === "f") { consume(); frequencyControl.current?.open(); }
    else if (tab === "valuation" && event.name === "d") { consume(); conventionControl.current?.open(); }
    else if (tab === "valuation" && event.name === "n") { consume(); update({ endOfMonth: !draft.endOfMonth }); }
  }, { enabled: focused, allowEditable: true, phase: "before", scope: "bond-calculator:form" });
  const notices = [...data?.notices ?? [],
    ...(result && !result.spread && !loading && !error ? ["Treasury spread needs matching dated tenors bracketing remaining maturity. Older servers may lack observation dates."] : [])];
  usePaneNoticeFooter({ registrationId: "bond-calculator:notices", notices, focused: focused && !activeField });
  // The tables' headers say "/ 100", so the settlement date is the context left to state.
  const settlementInfo = useMemo(() => tab !== "valuation" && result
    ? [{ id: "settlement", parts: [{ text: `settlement ${result.terms.settlement}`, tone: "muted" as const }] }] : undefined,
  [result, tab]);
  usePaneStatusFooter({ registrationId: "bond-calculator", loading, error: error ? `Treasury: ${error}` : null, info: settlementInfo,
    hints: [
      { id: "edit", key: "e", label: "dit", onPress: () => { setTab("valuation"); setActiveField("settlement"); } },
      ...(tab === "valuation" && !activeField ? [
        { id: "mode", key: "m", label: "ode", onPress: () => setMode(draft.mode === "yield" ? "price" : "yield") },
        { id: "frequency", key: "f", label: "requency", onPress: () => frequencyControl.current?.open() },
        { id: "day-count", key: "d", label: "ay count", onPress: () => conventionControl.current?.open() },
        { id: "eom", key: "n", label: " month end", onPress: () => update({ endOfMonth: !draft.endOfMonth }) },
      ] : []),
    ] });

  const availableWidth = Math.max(12, width - 3);
  const paired = width >= 70;
  const metricWidth = paired ? Math.floor(availableWidth / 2) : availableWidth;
  const dateField = (id: "settlement" | "maturity", label: string): GridField => ({ id, label, kind: "text", valueText: draft[id], placeholder: "YYYY-MM-DD",
    onText: (value) => update({ [id]: value }) });
  const numberField = (id: "coupon" | "quote", label: string): GridField => ({ id, label, value: Number(draft[id]) || 0, valueText: draft[id],
    allowNegative: id === "quote", onValue: (value) => update({ [id]: String(value) }), onClear: () => update({ [id]: "" }) });
  const gridFields = [dateField("settlement", "Settlement"), dateField("maturity", "Maturity"),
    numberField("coupon", "Coupon %"), numberField("quote", draft.mode === "yield" ? "Yield %" : "Clean price")];
  const metricRows = result ? [
    [{ label: "Clean price", value: fixed(result.analytics.cleanPrice) }, { label: "Yield", value: `${fixed(result.analytics.yieldPercent)}%` }],
    [{ label: "Dirty price", value: fixed(result.analytics.dirtyPrice) }, { label: "Accrued", value: fixed(result.analytics.accruedInterest) }],
    [{ label: "Macaulay", value: `${fixed(result.analytics.macaulayDuration)} yr` }, { label: "Modified", value: `${fixed(result.analytics.modifiedDuration)} yr` }],
    [{ label: "Convexity", value: `${fixed(result.analytics.convexity)} yr²` }, { label: "DV01 / 100", value: fixed(result.analytics.dv01, 6) }],
  ] : [];
  return <Box flexDirection="column" width={width} height={height}>
    {!tabsInHeader && <Tabs tabs={TABS} activeValue={tab} onSelect={selectTab} focused={focused && !activeField} dense />}
    {tab === "valuation" ? <>
      <QueryBar width={width} filters={[
        { id: "mode", label: "Mode", inline: true, value: draft.mode, options: MODES, onChange: setMode },
        { id: "frequency", label: "Frequency", value: draft.frequency, options: FREQUENCIES, onChange: (value: string) => update({ frequency: value }), controlRef: frequencyControl },
        { id: "dayCount", label: "Day count", value: draft.dayCount, options: CONVENTIONS, onChange: (value: string) => update({ dayCount: value }), controlRef: conventionControl },
        { id: "endOfMonth", kind: "toggle", label: "End-of-month", value: draft.endOfMonth, onChange: (value) => update({ endOfMonth: value }) },
      ]} />
      <FieldGrid fields={gridFields} activeId={activeField} width={width} focused={focused}
        // Four inputs sit on one row or two, never three and an orphan.
        columns={width >= 100 ? 4 : width >= 42 ? 2 : 1}
        onActivate={(id) => setActiveField(id as (typeof FIELDS)[number])} onDeactivate={() => setActiveField(null)} />
      <ScrollBox flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
        {evaluation.error ? <Notice tone="negative">{evaluation.error}</Notice> : result ? <Box paddingX={1} flexDirection="column">
          <Section title="Per 100 face">
            {metricRows.map((row, index) => <Box key={index} flexDirection={paired ? "row" : "column"}>{row.map((metric) => <KeyValueRow key={metric.label} {...metric} width={metricWidth} color={index === 0 ? colors.textBright : undefined} />)}</Box>)}
          </Section>
          <Section title={result.spread ? `Treasury · as of ${result.spread.asOf}` : "Treasury"}>
            <KeyValueRow label="Spread" value={result.spread ? `${result.spread.spreadBps >= 0 ? "+" : ""}${fixed(result.spread.spreadBps, 1)} bp` : "Unavailable"} width={availableWidth} color={result.spread ? colors.borderFocused : colors.textMuted} />
            {result.spread ? <KeyValueRow label="Par yield" value={`${fixed(result.spread.benchmarkPercent)}%`} width={availableWidth} /> : null}
          </Section>
        </Box> : null}
      </ScrollBox>
    </> : evaluation.error ? <Notice tone="negative">{evaluation.error}</Notice> : result ? <>
      {tab === "cashflows" ? <DataTableView emptyStateTitle="No future cash flows" columns={FLOW_COLUMNS} items={result.analytics.cashFlows} getItemKey={(row) => row.date}
        // A read-only cursor, so j/k and the page keys reach every payment.
        selection={{ kind: "index", selectedIndex: flowRow, onChange: setFlowRow }} focused={focused} rootHeight={Math.max(1, height - tabRows)} sortColumnId={null} sortDirection="asc"
        renderCell={(row, column) => ({ text: column.id === "date" ? row.date : fixed(row[column.id as "amount" | "presentValue"]) })} />
        : <DataTableView emptyStateTitle="No yield scenarios" columns={SHOCK_COLUMNS} items={result.sensitivity} getItemKey={(row) => String(row.shiftBps)} selection={{ kind: "none" }} focused={focused} rootHeight={Math.max(1, height - tabRows)} sortColumnId={null} sortDirection="asc"
          renderCell={(row, column) => { const value = row[column.id as keyof typeof row]; return { text: column.id === "shiftBps" ? `${value! > 0 ? "+" : ""}${value}` : fixed(value), color: column.id === "priceChange" && value != null ? value > 0 ? colors.positive : value < 0 ? colors.negative : colors.text : undefined }; }} />}
    </> : null}
  </Box>;
}
