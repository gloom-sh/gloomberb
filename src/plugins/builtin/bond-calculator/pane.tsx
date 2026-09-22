import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Box, ScrollBox, Text, type ScrollBoxRenderable } from "../../../ui";
import { Checkbox, DataTableView, KeyValueRow, Notice, NumberField, Section, SegmentedControl, SelectButton, Tabs, TextField, usePaneNoticeFooter, type SelectControl } from "../../../components";
import { usePaneSettingValue, usePaneStateValue, useShortcut } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { usePaneStatusFooter } from "../shared/pane-footer";
import { useAutoRefresh } from "../shared/auto-refresh";
import { loadBondBenchmark } from "./client";
import { bondDraftFromOptions, calculateBond, type BondDraft } from "./model";

const TABS = [{ label: "Valuation", value: "valuation" }, { label: "Cash flows", value: "cashflows" }, { label: "Sensitivity", value: "sensitivity" }];
const MODES = [{ label: "From yield", value: "yield" }, { label: "From price", value: "price" }];
const FREQUENCIES = [{ label: "Annual", value: "1" }, { label: "Semiannual", value: "2" }, { label: "Quarterly", value: "4" }];
const CONVENTIONS = [{ label: "ACT/ACT ICMA", value: "act-act-icma" }, { label: "30/360 US", value: "30-360-us" }];
const FIELDS = ["settlement", "maturity", "coupon", "quote", "mode", "frequency", "dayCount", "endOfMonth"] as const;
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
const noop = () => {};
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
  const formScroll = useRef<ScrollBoxRenderable>(null);
  useEffect(() => { if (activeField) formScroll.current?.scrollTo(0); }, [activeField]);
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
  useShortcut((event) => {
    if (event.defaultPrevented || event.propagationStopped || event.ctrl || event.alt || event.meta || event.super) return;
    const consume = () => { event.preventDefault(); event.stopPropagation(); };
    if (event.name === "tab" && tab === "valuation") {
      consume();
      const index = activeField ? FIELDS.indexOf(activeField) : event.shift ? 0 : -1;
      setActiveField(FIELDS[(index + (event.shift ? -1 : 1) + FIELDS.length) % FIELDS.length]!);
    } else if (event.name === "escape" && activeField) { consume(); setActiveField(null); }
    else if (event.targetEditable) return;
    else if (event.name === "e") { consume(); setTab("valuation"); setActiveField("settlement"); }
    else if (event.name === "r") { consume(); void load(); }
    else if ((event.name === "j" || event.name === "k") && tab === "valuation") {
      consume();
      const index = activeField ? FIELDS.indexOf(activeField) : -1;
      setActiveField(FIELDS[(index + (event.name === "j" ? 1 : -1) + FIELDS.length) % FIELDS.length]!);
    } else if (["enter", "return", "space"].includes(event.name ?? "")) {
      if (activeField === "frequency") { consume(); frequencyControl.current?.open(); }
      if (activeField === "dayCount") { consume(); conventionControl.current?.open(); }
      if (activeField === "endOfMonth") { consume(); update({ endOfMonth: !draft.endOfMonth }); }
      if (activeField === "mode") { consume(); setMode(draft.mode === "yield" ? "price" : "yield"); }
    }
  }, { enabled: focused, allowEditable: true, phase: "before", scope: "bond-calculator:form" });
  const notices = [...data?.notices ?? [],
    ...(result && !result.spread && !loading && !error ? ["Treasury spread needs matching dated tenors bracketing remaining maturity. Older servers may lack observation dates."] : [])];
  usePaneNoticeFooter({ registrationId: "bond-calculator:notices", notices, focused: focused && !activeField });
  usePaneStatusFooter({ registrationId: "bond-calculator", loading, error: error ? `Treasury: ${error}` : null,
    hints: [{ id: "edit", key: "e", label: "dit", onPress: () => { setTab("valuation"); setActiveField("settlement"); } }] });

  const availableWidth = Math.max(12, width - 3);
  const paired = width >= 70;
  const metricWidth = paired ? Math.floor(availableWidth / 2) : availableWidth;
  const fieldWidth = Math.max(12, Math.min(22, Math.floor((availableWidth - 2) / 2)));
  const field = (id: "settlement" | "maturity" | "coupon" | "quote", label: string) => {
    const props = { label, value: draft[id], width: fieldWidth, focused: focused && activeField === id,
      onChange: (value: string) => update({ [id]: value }), onSubmit: () => setActiveField(null), onMouseDown: () => setActiveField(id) };
    return id === "settlement" || id === "maturity" ? <TextField {...props} type="date" /> : <NumberField {...props} allowDecimal allowNegative={id === "quote"} />;
  };
  const metricRows = result ? [
    [{ label: "Clean price", value: fixed(result.analytics.cleanPrice) }, { label: "Yield", value: `${fixed(result.analytics.yieldPercent)}%` }],
    [{ label: "Dirty price", value: fixed(result.analytics.dirtyPrice) }, { label: "Accrued", value: fixed(result.analytics.accruedInterest) }],
    [{ label: "Macaulay", value: `${fixed(result.analytics.macaulayDuration)} yr` }, { label: "Modified", value: `${fixed(result.analytics.modifiedDuration)} yr` }],
    [{ label: "Convexity", value: `${fixed(result.analytics.convexity)} yr²` }, { label: "DV01 / 100", value: fixed(result.analytics.dv01, 6) }],
  ] : [];
  return <Box flexDirection="column" width={width} height={height}>
    <Tabs tabs={TABS} activeValue={tab} onSelect={selectTab} focused={focused && !activeField} dense />
    {tab === "valuation" ? <ScrollBox ref={formScroll} flexGrow={1} flexBasis={0} minHeight={0} scrollY focusable={false}>
      <Box flexDirection="column" paddingX={1} gap={1}>
        <Box flexDirection="row" gap={2}>{field("settlement", "Settlement")}{field("maturity", "Maturity")}</Box>
        <Box flexDirection="row" gap={2}>{field("coupon", "Coupon %")}{field("quote", draft.mode === "yield" ? "Yield %" : "Clean price / 100")}</Box>
        <SegmentedControl options={MODES} value={draft.mode} onChange={setMode} focused={focused && activeField === "mode"} shortcutScope="bond-calculator:mode" />
        <Box flexDirection={width >= 60 ? "row" : "column"} gap={1}>
          <SelectButton label="Frequency" value={draft.frequency} options={FREQUENCIES} onChange={(value) => update({ frequency: value })} emphasized={activeField === "frequency"} onFocus={() => setActiveField("frequency")} controlRef={frequencyControl} />
          <SelectButton label="Day count" value={draft.dayCount} options={CONVENTIONS} onChange={(value) => update({ dayCount: value })} emphasized={activeField === "dayCount"} onFocus={() => setActiveField("dayCount")} controlRef={conventionControl} />
        </Box>
        <Checkbox label="End-of-month coupons" checked={draft.endOfMonth} active={activeField === "endOfMonth"} onChange={(value) => { setActiveField("endOfMonth"); update({ endOfMonth: value }); }} />
      </Box>
      {evaluation.error ? <Notice tone="negative">{evaluation.error}</Notice> : result ? <Box paddingX={1} flexDirection="column">
        <Section title={`Settlement ${result.terms.settlement} · per 100 face`}>
          {metricRows.map((row, index) => <Box key={index} flexDirection={paired ? "row" : "column"}>{row.map((metric) => <KeyValueRow key={metric.label} {...metric} width={metricWidth} color={index === 0 ? colors.textBright : undefined} />)}</Box>)}
        </Section>
        <Section title={result.spread ? `Treasury · as of ${result.spread.asOf}` : "Treasury"}>
          <KeyValueRow label="Spread" value={result.spread ? `${result.spread.spreadBps >= 0 ? "+" : ""}${fixed(result.spread.spreadBps, 1)} bp` : "Unavailable"} width={availableWidth} color={result.spread ? colors.borderFocused : colors.textMuted} />
          {result.spread ? <KeyValueRow label="Par yield" value={`${fixed(result.spread.benchmarkPercent)}%`} width={availableWidth} /> : null}
        </Section>
      </Box> : null}
    </ScrollBox> : evaluation.error ? <Notice tone="negative">{evaluation.error}</Notice> : result ? <>
      <Box paddingX={1} height={1}><Text fg={colors.textMuted}>{`Settlement ${result.terms.settlement} · per 100 face`}</Text></Box>
      {tab === "cashflows" ? <DataTableView emptyStateTitle="No future cash flows" columns={FLOW_COLUMNS} items={result.analytics.cashFlows} getItemKey={(row) => row.date} selection={{ kind: "none" }} focused={focused} rootHeight={Math.max(1, height - 2)} sortColumnId={null} sortDirection="asc" onHeaderClick={noop}
        renderCell={(row, column) => ({ text: column.id === "date" ? row.date : fixed(row[column.id as "amount" | "presentValue"]) })} />
        : <DataTableView emptyStateTitle="No yield scenarios" columns={SHOCK_COLUMNS} items={result.sensitivity} getItemKey={(row) => String(row.shiftBps)} selection={{ kind: "none" }} focused={focused} rootHeight={Math.max(1, height - 2)} sortColumnId={null} sortDirection="asc" onHeaderClick={noop}
          renderCell={(row, column) => { const value = row[column.id as keyof typeof row]; return { text: column.id === "shiftBps" ? `${value! > 0 ? "+" : ""}${value}` : fixed(value), color: column.id === "priceChange" && value != null ? value > 0 ? colors.positive : value < 0 ? colors.negative : colors.text : undefined }; }} />}
    </> : null}
  </Box>;
}
