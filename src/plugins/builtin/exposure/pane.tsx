import { useCallback, useMemo, useRef } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { ExposureEvidence, ExposurePayload } from "../../../api-client/exposure";
import { ActionRow, ChartTableHeader, DataTableView, EmptyState, KeyValueRow, PageStackView, PaneStatusBody, QueryBar, SectionHeading, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableColumn, type PaneHint, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAppSelector, useAsyncResource, useAutoRefresh, useMarketData, usePaneInstance, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, ScrollBox, Text, useRendererHost } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { ExposurePathDiagram, ExposureRanges } from "./charts";
import { fetchExposure, fetchScenarios, validateExposure } from "./client";
import { ExposureEditor, type ExposureInputs } from "./editor";
import { portfolioHoldings, watchlistHoldings } from "./holdings";
import { basisLabel, DEFAULT_SCENARIO, fraction, parseCustomScenario, parseHoldings, pathRows, portfolioRows, rangeText, tableRows, TABS, type ExposureRow } from "./model";
import { useExposureEvidence } from "./evidence";

function EvidenceItem({ item }: { item: ExposureEvidence }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  return <Box flexDirection="column" paddingY={1}>
    <KeyValueRow labelWidth={20} label="Evidence" value={`${item.tier} · ${item.asOf ?? "undated"}`} detail={item.confidence === null ? undefined : `${Math.round(item.confidence * 100)}% confidence`} />
    <KeyValueRow labelWidth={20} label="Period / units" value={`${item.period ?? "unknown"} · ${item.units}${item.currency ? ` ${item.currency}` : ""}`} />
    {item.revision ? <KeyValueRow labelWidth={20} label="Revision" value={item.revision} /> : null}
    {item.quote ? <Text fg={colors.textBright}>{item.quote}</Text> : <Text fg={colors.textDim}>{item.tier === "user" ? "User-supplied assumption" : "Structured observation; no verbatim quote"}</Text>}
    {item.url ? <ActionRow label="Open primary evidence" onPress={() => void host.openExternal(item.url!)} /> : null}
  </Box>;
}
function ExposureDetail({ row, data, width }: { row: ExposureRow | null; data: ExposurePayload; width: number }) {
  const colors = useThemeColors();
  const unknowns = row ? row.unknowns : [...data.unknowns, ...data.holdings.flatMap(h => h.unknowns.map(u => `${h.symbol}: ${u}`))];
  return <ScrollBox flexGrow={1} flexBasis={0} minHeight={0} scrollY contentOptions={{ paddingX: 1 }}>
    {row ? <>
      <KeyValueRow labelWidth={20} label="Basis / period" value={`${basisLabel(row.basis)} · ${row.period ?? "unknown"}`} />
      <KeyValueRow labelWidth={20} label={row.concentration ? "Gross exposure" : "Exposure"} value={rangeText(row.exposure)} detail={`${row.classification}${row.incomplete ? " · incomplete bound" : ""}`} />
      <KeyValueRow labelWidth={20} label={row.concentration ? "Signed exposure" : "Operating stress"} value={rangeText(row.impact)} detail={row.concentration ? "NAV-weighted operating exposure; not a scenario change" : "Estimated change in the stated denominator"} />
      {row.components.map(component => <Box key={component.id} flexDirection="column" paddingY={1}>
        <SectionHeading title={component.label} />
        <KeyValueRow labelWidth={20} label="Channel" value={`${component.channel} · order ${component.order} · ${component.classification}`} />
        {component.proportionalEstimatePct != null ? <KeyValueRow labelWidth={20} label="Proportional chain" value={`${component.proportionalEstimatePct.toFixed(2)}%`} detail="Estimate; assumes proportional transmission" /> : null}
        {component.path.length ? <ExposurePathDiagram component={component} width={width - 2} height={4} /> : null}
        {component.path.map((hop, i) => <Box key={i} flexDirection="column" paddingY={1}>
          <SectionHeading title={`Hop ${i + 1}: ${hop.from.symbol ?? hop.from.name} to ${hop.to.symbol ?? hop.to.name}`} />
          <KeyValueRow labelWidth={20} label="Disclosed share" value={hop.pct === null ? "Unknown" : `${hop.pct}% ${basisLabel(hop.basis)}`} detail={`Denominator: ${hop.denominatorEntityId ?? "unknown"}`} />
          {hop.evidence.map(e => <EvidenceItem key={e.id} item={e} />)}
        </Box>)}
        {component.evidence.filter(e => !component.path.some(h => h.evidence.some(p => p.id === e.id))).map(e => <EvidenceItem key={e.id} item={e} />)}
      </Box>)}
    </> : null}
    {unknowns.length ? <><SectionHeading title="What we could not see" />{[...new Set(unknowns)].map((u, i) => <Box paddingY={1} key={i}><Text fg={colors.warning}>{u}</Text></Box>)}</> : <Text fg={colors.textDim}>No additional missing fields reported.</Text>}
  </ScrollBox>;
}

export function ExposurePane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const instance = usePaneInstance();
  const market = useMarketData();
  const config = useAppSelector(s => s.config);
  const tickers = useAppSelector(s => s.tickers);
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const upgrade = useCloudUpgradeAction("expo");
  const { createPaneFromTemplate } = usePluginAppActions();
  const [openingScenario] = usePaneSettingValue("scenario", "taiwan-disruption");
  const [customSetting] = usePaneSettingValue("customScenario", "");
  const [openingDepth] = usePaneSettingValue("depth", 2);
  const [openingNav] = usePaneSettingValue("nav", "");
  const [openingCash] = usePaneSettingValue("cash", "");
  const [snapshotSetting] = usePaneSettingValue<ExposurePayload | null>("exposureSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateExposure(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const initialInput = snapshot ? snapshot.holdings.map(h => `${h.symbol}=${h.weight}`).join(" ") : instance?.params?.input ?? instance?.params?.arg ?? "";
  const initialScenario = useMemo(() => { if (snapshot) return snapshot.scenario; try { return customSetting ? parseCustomScenario(customSetting) : DEFAULT_SCENARIO; } catch { return DEFAULT_SCENARIO; } }, [snapshot, customSetting]);
  const [inputs, setInputs] = usePluginPaneState<ExposureInputs>("exposure:inputs", { input: initialInput, source: /^(PORT|WATCH):/.test(initialInput) ? initialInput : "typed", nav: String(openingNav), cash: String(openingCash), depth: snapshot?.depth ?? Number(openingDepth), scenario: initialScenario });
  const [scenarioId, setScenarioId] = usePluginPaneState("exposure:scenario", snapshot ? snapshot.scenario.id ?? "captured" : customSetting ? "custom" : openingScenario);
  const [openingTab] = usePaneSettingValue("tab", "table");
  const [tab, setTab] = usePluginPaneState("exposure:tab", openingTab);
  const [openingView] = usePaneSettingValue("view", "stress");
  const [view, setView] = usePluginPaneState("exposure:view", openingView);
  const [selectedId, setSelected] = usePluginPaneState<string | null>("exposure:selected", null);
  const [detailId, setDetail] = usePluginPaneState<string | null>("exposure:detail", null);
  const [editing, setEditing] = usePluginPaneState("exposure:editing", !initialInput && !snapshot);
  const [sort, setSort] = usePluginPaneState("exposure:sort", { column: "exposure", direction: "desc" as "asc" | "desc" });
  const libraryLoader = useCallback(() => snapshot ? Promise.resolve([snapshot.scenario]) : fetchScenarios(), [snapshot, accessKey]);
  const library = useAsyncResource(libraryLoader, { clearOnError: isAccessDenied });
  const scenario = snapshot?.scenario ?? (scenarioId === "custom" ? inputs.scenario : library.data?.find(s => s.id === scenarioId) ?? (scenarioId === DEFAULT_SCENARIO.id ? DEFAULT_SCENARIO : null));
  const portfolio = config.portfolios.find(p => inputs.source === `PORT:${p.id}`);
  const localTickers = useMemo(() => [...tickers.values()], [tickers]);
  // Freeze a local selection until the user explicitly refreshes. Tick-by-tick marks must not rerun scenarios.
  const sourceKey = JSON.stringify({ inputs, scenario, accessKey });
  const valuation = useRef({ portfolio, localTickers, market });
  valuation.current = { portfolio, localTickers, market };
  const loader = useCallback(async () => {
    if (snapshot) return snapshot;
    if (!scenario) throw new Error("Select an available scenario.");
    let holdings;
    const { portfolio, localTickers, market } = valuation.current;
    if (portfolio) {
      if (!market) throw new Error("Market data connection unavailable for portfolio weights.");
      holdings = await portfolioHoldings(portfolio, localTickers, Number(inputs.nav), market);
    }
    else if (inputs.source.startsWith("WATCH:")) holdings = watchlistHoldings(localTickers, inputs.source.slice(6));
    else if (inputs.source !== "typed") throw new Error("The saved holdings source is no longer available.");
    else holdings = parseHoldings(inputs.input);
    const cash = inputs.cash.trim() ? Number(inputs.cash) : undefined;
    if (cash !== undefined && (!Number.isFinite(cash) || Math.abs(cash) > 10)) throw new Error("Cash must be a NAV fraction between -10 and 10.");
    return fetchExposure({ holdings, scenario, depth: inputs.depth, ...(cash === undefined ? {} : { cashWeight: cash }) });
  // Explicit request state, including the account, owns recalculation. Quote changes do not.
  }, [sourceKey, snapshot]);
  const resource = useAsyncResource(inputs.input || inputs.source !== "typed" || snapshot ? loader : null, { clearOnError: isAccessDenied });
  const data = resource.data;
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused: focused && !editing });
  const rawRows = useMemo(() => !data ? [] : tab === "paths" ? pathRows(data) : tab === "portfolio" ? portfolioRows(data, view) : tableRows(data), [data, tab, view]);
  const rows = useMemo(() => [...rawRows].sort((a, b) => {
    const get = (r: ExposureRow) => sort.column === "exposure" ? r.exposure?.high ?? -Infinity : sort.column === "impact" ? r.impact?.low ?? -Infinity : sort.column === "weight" ? r.weight ?? -Infinity : sort.column === "basis" ? r.basis ?? "" : r.symbol;
    const av = get(a), bv = get(b); const delta = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
    return (sort.direction === "asc" ? delta : -delta) || a.id.localeCompare(b.id);
  }), [rawRows, sort]);
  const selected = rows.find(r => r.id === selectedId) ?? rows[0] ?? null;
  const detail = rows.find(r => r.id === detailId) ?? null;
  const source = selected?.components.flatMap(c => [...c.evidence, ...c.path.flatMap(h => h.evidence)]).find(e => e.url)?.url;
  const symbol = selected?.symbol.split(",")[0]?.trim();
  const detailOpen = editing || !!detail || detailId === "unknowns";
  const { strip, rows: tabRows } = usePaneTabs({ tabs: TABS, activeValue: tab, onSelect: value => { setTab(value); setDetail(null); }, focused: focused && !editing, dense: true });
  useExposureEvidence(data, tab, view, rows.map(r => r.id));
  const hints: PaneHint[] = editing ? [] : [
    { id: "edit", key: "s", label: "cenario", title: "Edit scenario and holdings", onPress: () => setEditing(true) },
    { id: "unknowns", key: "v", label: "isibility", title: "What we could not see", onPress: () => setDetail("unknowns") },
    ...(selected ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => setDetail(selected.id) }] : []),
    ...(source ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(source) }] : []),
    ...(symbol ? [
      { id: "supply", key: "c", label: "hain", title: "Supply chain", onPress: () => createPaneFromTemplate("supply-chain-pane", { symbol }) },
      { id: "des", key: "d", label: "es", onPress: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol }) },
      { id: "fa", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: symbol }) },
    ] : []),
    ...(data?.access === "preview" ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: "exposure", loading: resource.loading, error: data ? resource.error : null, hints,
    info: data ? [{ id: "asof", parts: [{ text: `analyzed ${data.evaluatedAt.slice(0, 10)}`, tone: "muted" as const }] }] : [] });
  usePaneNoticeFooter({ registrationId: "exposure:notices", focused, notices: [...(library.error ? [library.error] : []), ...(data?.unknowns ?? []), ...(data?.holdings.flatMap(h => h.unknowns.map(u => `${h.symbol}: ${u}`)) ?? [])] });
  const sources = [{ value: "typed", label: "Typed holdings" }, ...config.portfolios.map(p => ({ value: `PORT:${p.id}`, label: `PORT · ${p.name}` })), ...config.watchlists.map(w => ({ value: `WATCH:${w.id}`, label: `Watchlist · ${w.name}` }))];
  const bodyHeight = Math.max(3, height - tabRows);
  const concentration = tab === "portfolio" && view !== "stress";
  const columns: DataTableColumn[] = [
    { id: "symbol", label: tab === "portfolio" ? "Holdings" : "Holding", width: tab === "portfolio" ? 18 : width < 115 ? 9 : 12, align: "left" },
    { id: "label", label: tab === "paths" ? "Evidence path" : tab === "table" ? "Shock" : "Target", width: tab === "paths" ? 32 : width < 115 ? 12 : 20, align: "left" },
    { id: "basis", label: "Basis", width: width < 115 ? 14 : 17, align: "left" },
    { id: "exposure", label: concentration ? "Gross exp. %" : "Exposure % / type", width: 23, align: "right" },
    { id: "impact", label: concentration ? "Signed exp. %" : "Stress est. %", width: 20, align: "right" },
    { id: "period", label: "Period", width: 13, align: "left" },
    { id: "weight", label: tab === "portfolio" ? concentration ? "Gross wt. %" : "Covered wt. %" : "NAV wt. %", width: 13, align: "right" },
  ];
  const figures: StatItem[] = data ? tab === "portfolio" ? [
    { label: "Gross holdings", value: fraction(data.portfolio.grossWeight) }, { label: "Net holdings", value: fraction(data.portfolio.netWeight) },
    { label: "Unknown gross", value: fraction(data.portfolio.unknownGrossWeight), tone: "warning" },
    { label: "Cash / residual", value: `${data.portfolio.cashWeight === null ? "?" : fraction(data.portfolio.cashWeight)} / ${fraction(data.portfolio.residualWeight)}` },
  ] : [
    { label: "Holding weight", value: selected?.weight == null ? "--" : fraction(selected.weight) },
    { label: "Exposure", value: rangeText(selected?.exposure ?? null), detail: selected?.exposure ? selected.classification : undefined, tone: selected?.classification === "disclosed" ? "accent" : "warning" },
    { label: "Operating stress", value: rangeText(selected?.impact ?? null), detail: "estimate" },
    { label: "Bound", value: selected?.incomplete ? "Incomplete" : "Available", tone: selected?.incomplete ? "warning" : "muted" },
  ] : [];
  const query = <QueryBar width={width} filters={[
    { id: "scenario", label: "Scenario", value: scenarioId, options: [...(library.data ?? [DEFAULT_SCENARIO]).map(s => ({ value: s.id ?? (snapshot ? "captured" : "custom"), label: s.label })), { value: "custom", label: "Custom" }].filter((s, i, all) => all.findIndex(v => v.value === s.value) === i), onChange: (value: string) => { if (value === "custom") setEditing(true); else setScenarioId(value); } },
    ...(tab === "portfolio" ? [{ id: "group", label: "View", value: view, options: [{ value: "stress", label: "Stress" }, { value: "country", label: "Country" }, { value: "supplier", label: "Supplier" }, { value: "customer", label: "Customer" }], onChange: setView }] : []),
  ]} meta={tab === "portfolio" ? "NAV-weighted operating exposure" : `${data?.depth ?? inputs.depth} hops`} />;
  if (!data && isCloudSessionRequired(resource.error) && !editing) return <SignInWall action="analyze exposures" needsVerification={session.needsVerification} />;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PageStackView focused={focused && !editing} detailOpen={detailOpen} onBack={() => { setDetail(null); setEditing(false); }}
      detailTitle={editing ? "Scenario and holdings" : detail ? `${detail.symbol} · ${detail.label}` : "What we could not see"}
      detailContent={editing ? <ExposureEditor initial={{ ...inputs, scenario: scenario ?? inputs.scenario }} sources={sources} focused={focused} width={width} onCancel={() => setEditing(false)} onSave={value => { setInputs(value); setScenarioId("custom"); setEditing(false); setDetail(null); }} /> : data ? <ExposureDetail row={detail} data={data} width={width} /> : null}
      rootContent={<PaneStatusBody loading={!data && resource.loading} error={!data ? resource.error : null} subject="exposure analysis">
        {data ? <DataTableView<ExposureRow> columns={columns} items={rows} getItemKey={r => r.id} rootWidth={width} rootHeight={bodyHeight} focused={focused && !detailOpen}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: r => r.id, onChange: setSelected }}
          onActivate={row => setDetail(row.id)} selectedTextOverridesCellColor showHorizontalScrollbar
          sortColumnId={sort.column} sortDirection={sort.direction} onHeaderClick={column => setSort(old => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))}
          rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns} query={query} figures={figures}
            chart={tab === "paths" ? { render: size => <ExposurePathDiagram component={selected?.components[0] ?? null} {...size} />, minRows: 5, maxRows: 5, strip: null }
              : rows.some(r => r.exposure) ? { render: size => <ExposureRanges rows={rows} showTargets={tab === "portfolio" || data.scenario.shocks.length > 1} selectedId={selected?.id ?? null} onSelect={setSelected} onOpen={setDetail} {...size} />, minRows: 2, maxRows: Math.min(8, rows.filter(r => r.exposure && r.shockId === selected?.shockId && r.basis === selected?.basis && r.period === selected?.period).length + 1), strip: null } : null} />}
          renderCell={(row, col) => ({ text: col.id === "symbol" ? row.symbol : col.id === "label" ? row.label : col.id === "exposure" ? rangeText(row.exposure) + (row.exposure ? row.classification === "disclosed" ? " dsc" : " est" : "") + (row.incomplete ? " *" : "") : col.id === "impact" ? rangeText(row.impact) : col.id === "basis" ? basisLabel(row.basis) : col.id === "period" ? row.period ?? "--" : col.id === "classification" ? row.classification : fraction(row.weight ?? 0),
            color: col.id === "classification" ? row.classification === "disclosed" ? colors.borderFocused : colors.warning : col.id === "symbol" ? colors.textBright : colors.text,
            ...(col.id === "weight" ? { value: row.weight === null ? null : row.weight * 100 } : {}) })}
          emptyStateTitle={tab === "paths" ? "No supported exposure paths for this scenario." : "No quantified exposure in this view."}
          bodyAfter={data.access === "preview" ? <UpgradeLabel text="Pro: full holdings and deeper exposure paths" onPress={upgrade} role="exposure-upgrade" /> : undefined} />
          : !resource.loading && !resource.error ? <EmptyState title="Choose holdings and a scenario." actions={<ActionRow label="Configure exposure" onPress={() => setEditing(true)} />} /> : null}
      </PaneStatusBody>} />
  </Box>;
}
