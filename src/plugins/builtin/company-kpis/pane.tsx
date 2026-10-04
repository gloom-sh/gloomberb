import { useCallback, useMemo, useRef } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { KpiObservation } from "../../../api-client/company-kpis";
import { ChartTableHeader, DataTableStackView, DetailScrollBody, EmptyState, KeyValueRow, PaneStatusBody, QueryBar, SectionHeading,
  useChartTableSelection, usePaneMenuItems, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableCell, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedCompanyData, loadCompanyData, KPI_UNAVAILABLE, validateCompanyData, type CompanyDataset, type CompanyMode } from "./client";
import { useCompanyEvidence } from "./screenshot-evidence";
import { allGuidance, allObservations, basisLabel, changeText, changeTone, companyColumns, dimensionLabel, directionLabel, directionTone, guideGroupKey, guidanceSeries, fiscalLabel,
  isGuidance, exactObservation, observationValue, observationChange, observationChart, periodOrder, outcomeLabel, rangeText, seriesLabel, unitLabel, unitSuffix, valueText, type CompanyRow } from "./model";
import { PriceSparkline } from "../../../components/price-sparkline/view";
import type { PricePoint } from "../../../types/financials";
import { toneColor, withoutQuietColumns } from "../shared/research-cells";

/** Columns that say nothing while every row is the company's consolidated, as-reported figure. */
const QUIET_COLUMNS = { basis: ["Reported"], scope: ["Consolidated"] };

type Item = { id: string; row: CompanyRow } | { id: string; row: null };
const getId = (item: Item) => item.id;
function DisclosureEvidence({ row, sourceId, onSource, width }: { row: CompanyRow; sourceId: string | null; onSource: (id: string) => void; width: number }) {
  const colors = useThemeColors();
  const evidence = row.evidence.find((entry) => entry.id === sourceId) ?? row.evidence[0]!;
  return <Box flexDirection="column" paddingX={1}>
    {row.evidence.length > 1 ? <QueryBar width={Math.max(1, width - 4)} filters={[{ id: "source", label: "Document", value: evidence.id,
      options: row.evidence.map((entry) => ({ value: entry.id, label: `${entry.publishedAt.slice(0, 10)} · ${entry.title}` })), onChange: onSource }]} /> : null}
    <KeyValueRow label="Value" value={isGuidance(row) ? rangeText(row) : observationValue(row)} detail={row.currency || row.unit === "volume" || row.unit === "count" ? unitLabel(row) : undefined} labelWidth={18} />
    <KeyValueRow label="Fiscal period" value={row.period.label} detail={row.period.end ? row.period.start ? `${row.period.start} to ${row.period.end}` : `${row.period.kind === "instant" ? "As of" : "Ended"} ${row.period.end}` : "Calendar dates unavailable"} labelWidth={18} />
    <KeyValueRow label="Basis" value={basisLabel(row.basis)} labelWidth={18} />
    <KeyValueRow label="Scope" value={dimensionLabel(row.dimensions) || "Consolidated"} labelWidth={18} />
    <KeyValueRow label="Definition" value={row.metric.definition} labelWidth={18} />
    <KeyValueRow label="Revision" value={`${row.revision}${row.current ? " · current" : " · superseded"}${!isGuidance(row) && (row.conflict || row.contested) ? " · conflicting disclosures" : ""}`} labelWidth={18} />
    {row.revisionReason ? <KeyValueRow label="Correction" value={row.revisionReason} labelWidth={18} /> : null}
    {isGuidance(row) ? <>
      <KeyValueRow label="Issued" value={row.issuedDate} detail={directionLabel(row.direction)} labelWidth={18} />
      <KeyValueRow label="Source range" value={row.rangeText} labelWidth={18} />
      {row.conditions ? <KeyValueRow label="Conditions" value={row.conditions} labelWidth={18} /> : null}
      <KeyValueRow label="Later actual" value={row.actual ? valueText(row, row.actual.value) : "Pending"} detail={row.actual ? outcomeLabel(row) : undefined} labelWidth={18} />
    </> : null}
    <Box key={evidence.id} flexDirection="column" paddingTop={1}>
      <SectionHeading title="Source evidence" />
      <KeyValueRow label="Document" value={evidence.title} labelWidth={18} />
      <KeyValueRow label="Published" value={evidence.publishedAt.slice(0, 10)} detail={`${evidence.country} · ${evidence.language}`} labelWidth={18} />
      <KeyValueRow label="Confidence" value={`${Math.round(evidence.confidence * 100)}%`} detail={evidence.quoteMatchMode === "exact" ? "Exact text match" : "Normalized text match"} labelWidth={18} />
      <Box paddingY={1}><Text fg={colors.textBright}>{evidence.quote}</Text></Box>
      <Text fg={colors.textDim}>{evidence.url}</Text>
    </Box>
  </Box>;
}

export function CompanyKpisPane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  return <CompanyView key={`${symbol}:kpis`} {...props} symbol={symbol} mode="kpis" />;
}
export function CompanyGuidancePane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  return <CompanyView key={`${symbol}:guidance`} {...props} symbol={symbol} mode="guidance" />;
}
function CompanyView({ symbol, mode, width, height, focused }: PaneProps & { symbol: string | null; mode: CompanyMode }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const { createPaneFromTemplate } = usePluginAppActions();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const openUpgrade = useCloudUpgradeAction(mode === "kpis" ? "kpis" : "guide");
  const [snapshotSetting] = usePaneSettingValue<CompanyDataset | null>("companySnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateCompanyData(snapshotSetting) : null; } catch { return null; } }, [snapshotSetting]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadCompanyData(mode, symbol!, accessKey, force), [mode, symbol, accessKey, snapshot]);
  const resource = useAsyncResource(symbol ? loader : null, { initialData: () => symbol ? cachedCompanyData(mode, symbol, accessKey) : null, clearOnError: isAccessDenied });
  const data = resource.data?.payload;
  const kpis = data && "series" in data ? data : null;
  const guidance = data && "guidance" in data ? data : null;
  const [openingTab] = usePaneSettingValue("tab", "table");
  const [tabValue, setTab] = usePluginPaneState<string>("company:tab", openingTab);
  const tab = ["table", "chart", "evidence", ...(guidance ? ["history"] : [])].includes(tabValue) ? tabValue : "table";
  const [openingMetric] = usePaneSettingValue("metric", "all");
  const [metric, setMetric] = usePluginPaneState<string>("company:metric", openingMetric);
  const [plotKey, setPlotKey] = usePluginPaneState<string>("company:plot", "");
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`company:selected:${tab}`, null);
  const [openId, setOpen] = usePluginPaneState<string | null>("company:open", null);
  const [sourceId, setSource] = usePluginPaneState<string | null>("company:source", null);
  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" }>("company:sort", { column: "period", direction: "desc" });
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);
  const observations = useMemo(() => kpis ? allObservations(kpis) : [], [kpis]);
  const guides = useMemo(() => guidance ? allGuidance(guidance) : [], [guidance]);
  const allRows = useMemo<CompanyRow[]>(() => [...observations, ...guides], [observations, guides]);
  const eligible = useMemo(() => allRows.filter((row) => metric === "all" || row.metricId === metric), [allRows, metric]);
  const plotOptions = useMemo(() => mode === "kpis"
    ? [...new Map(eligible.filter((row) => !isGuidance(row)).map((row) => [`${row.seriesKey}:${row.period.kind}`, { value: `${row.seriesKey}:${row.period.kind}`, label: `${seriesLabel(row)} · ${row.period.kind}` }])).values()]
    : [...new Map(eligible.filter(isGuidance).map((row) => [guideGroupKey(row), { value: guideGroupKey(row), label: `${seriesLabel(row)} · ${row.period.label}` }])).values()], [eligible, mode]);
  const activePlot = plotOptions.some((option) => option.value === plotKey) ? plotKey : plotOptions[0]?.value ?? "";
  const rows = useMemo(() => {
    const values = eligible.filter((row) => tab === "chart" ? (isGuidance(row) ? guideGroupKey(row) : `${row.seriesKey}:${row.period.kind}`) === activePlot
      : tab === "history" ? isGuidance(row) && !!row.actual
      : tab === "evidence" ? true : isGuidance(row) ? guidance?.guidance.some((current) => current.id === row.id) : kpis?.series.some((series) => series.latest.id === row.id));
    const key = (row: CompanyRow): string | number | null => {
      const guide = isGuidance(row) ? row : null;
      return sort.column === "metric" ? row.metric.name : sort.column === "value" ? guide ? guide.point ?? guide.low ?? guide.high : (row as KpiObservation).value
        : sort.column === "issued" ? guide?.issuedDate ?? null : sort.column === "confidence" ? row.confidence
        : sort.column === "actual" ? guide?.actual?.value ?? null : sort.column === "outcome" ? guide ? outcomeLabel(guide) : null
        : sort.column === "basis" ? row.basis : sort.column === "unit" ? unitLabel(row) : sort.column === "scope" ? dimensionLabel(row.dimensions)
        : sort.column === "published" ? row.evidence[0]!.publishedAt : sort.column === "revision" ? row.revision
        : sort.column === "quote" ? row.evidence[0]!.quote : sort.column === "change" ? guide ? guide.direction : observationChange(row as KpiObservation, observations).value
        : periodOrder(row);
    };
    return [...values].sort((a, b) => { const x = key(a), y = key(b);
      return x === null || y === null ? x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1
        : (x < y ? -1 : x > y ? 1 : a.metric.name.localeCompare(b.metric.name) || dimensionLabel(a.dimensions).localeCompare(dimensionLabel(b.dimensions)) || a.id.localeCompare(b.id)) * (sort.direction === "asc" ? 1 : -1);
    });
  }, [eligible, tab, activePlot, guidance, kpis, sort, observations]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0];
  const openRow = allRows.find((row) => row.id === openId);
  const activeRow = openRow ?? selected;
  const preview = data?.access === "preview" && data.lockedRows > 0;
  const lockedCount = preview ? Math.min(3, data.lockedRows) : 0;
  const items = useMemo<Item[]>(() => [...rows.map((row) => ({ id: row.id, row })), ...Array.from({ length: lockedCount }, (_, index) => ({ id: `locked:${index}`, row: null }))], [rows, lockedCount]);
  // One trend per series beside its latest value, once a series has three comparable points.
  const trends = useMemo(() => {
    const map = new Map<string, PricePoint[]>();
    for (const series of kpis?.series ?? []) {
      const points = series.observations.filter((row) => row.current && !row.conflict && !row.contested && exactObservation(row) && row.period.end && row.period.kind === series.latest.period.kind)
        .sort((a, b) => periodOrder(a).localeCompare(periodOrder(b))).map((row) => ({ date: new Date(row.period.end!), close: row.value }));
      if (points.length >= 3) map.set(series.latest.id, points);
    }
    return map;
  }, [kpis]);
  const columns = useMemo(() => withoutQuietColumns(companyColumns(mode === "guidance", tab === "evidence", tab === "history", mode === "kpis" && tab === "table" && trends.size > 0 && width >= 100),
    rows, (row, id) => id === "basis" ? basisLabel(row.basis) : id === "scope" ? dimensionLabel(row.dimensions) || "Consolidated" : "", QUIET_COLUMNS), [mode, tab, trends, rows, width]);
  const metricOptions = useMemo(() => [{ value: "all", label: "All metrics" }, ...[...new Map(allRows.map((row) => [row.metricId, { value: row.metricId, label: row.metric.name }])).values()]], [allRows]);
  const kpiChart = useMemo(() => observationChart(rows.filter((row): row is KpiObservation => !isGuidance(row)), colors.warning), [rows, colors.warning]);
  const series = useMemo(() => tab !== "chart" ? [] : mode === "kpis" ? kpiChart.series
    : guidanceSeries(guides, selected && isGuidance(selected) ? selected : undefined, { low: colors.textMuted, high: colors.warning, actual: colors.positive }), [tab, mode, kpiChart, guides, selected, colors]);
  const link = useChartTableSelection({ rows, getId: (row) => row.id, getDate: (row) => isGuidance(row) ? new Date(row.issuedDate) : kpiChart.dates.get(row.id) ?? null,
    selectedId: selected?.id ?? null, onSelect: setSelected, focused: focused && !openRow, enabled: tab === "chart" });
  const { strip, rows: tabRows } = usePaneTabs(data ? { tabs: [{ value: "table", label: mode === "guidance" ? "Tracker" : "Table" }, { value: "chart", label: "Chart" },
    ...(mode === "guidance" ? [{ value: "history", label: "History" }] : []), { value: "evidence", label: "Evidence" }], activeValue: tab,
    onSelect: (value) => { setTab(value); setOpen(null); }, focused, dense: true } : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  useCompanyEvidence(data ?? null, mode, tab, rows.map((row) => row.id));
  const hints: PaneHint[] = [
    ...(activeRow ? [{ id: "evidence", key: "e", label: "vidence", onPress: () => setOpen(activeRow.id) },
      { id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal((activeRow.evidence.find((entry) => entry.id === sourceId) ?? activeRow.evidence[0]!).url) }] : []),
    ...(symbol ? [{ id: "related", key: "c", label: mode === "kpis" ? "ompany guidance" : "ompany KPIs", onPress: () => createPaneFromTemplate(mode === "kpis" ? "company-guidance-pane" : "company-kpis-pane", { symbol }) },
    ] : []),
    ...(preview ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  usePaneMenuItems("company-disclosures:research", () => symbol ? [
    { id: "description", label: "Description (DES)", onSelect: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol }) },
    { id: "financials", label: "Financial Analysis (FA)", onSelect: () => createPaneFromTemplate("financial-analysis-pane", { symbol }) },
    { id: "price-chart", label: "Price Chart (G)", onSelect: () => createPaneFromTemplate("chart-composer-pane", { arg: symbol }) },
  ] : null, [symbol, createPaneFromTemplate]);
  usePaneStatusFooter({ registrationId: "company-kpis", loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale,
    info: data?.asOf ? [{ id: "as-of", parts: [{ text: `as of ${data.asOf.slice(0, 10)}`, tone: "muted" as const }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "company-kpis:notices", focused, notices: [resource.data?.refreshError,
    data?.truncated && data.access === "full" ? "The response reached its stored-record limit. Narrow the metric or date range in a CLI or REST query." : null,
    data?.coverage.conflicts ? "Conflicting disclosures are retained in Evidence and excluded from comparable trends." : null].filter((value): value is string => !!value) });
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall action="view company KPIs and guidance" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows);
  const query = <QueryBar width={width} filters={[{ id: "metric", label: "Metric", value: metric, defaultValue: "all", options: metricOptions,
    onChange: (value: string) => { setMetric(value); setSelected(null); setOpen(null); } }, ...(tab === "chart" && plotOptions.length ? [{ id: "series", label: "Series", value: activePlot,
      options: plotOptions, onChange: (value: string) => { setPlotKey(value); setSelected(null); } }] : [])]} />;
  const renderCell = (item: Item, column: (typeof columns)[number]): DataTableCell => {
    const row = item.row;
    if (!row) {
      if (!desktop && column.id === "metric" && item.id === "locked:0") return { text: "Unlock with Pro", content: <UpgradeLabel text="Unlock with Pro" onPress={openUpgrade} />, onMouseDown: openUpgrade };
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "metric" ? "Additional disclosure" : "Hidden"}</Text></Blurred> } : { text: "░░░░░", color: colors.textDim };
    }
    const guide = isGuidance(row) ? row : null;
    if (column.id === "trend") {
      const points = trends.get(row.id);
      if (!points) return { text: "" };
      const change = observationChange(row as KpiObservation, observations).value;
      const tone = changeTone(row as KpiObservation, change);
      return { text: "", content: <PriceSparkline priceHistory={points} width={column.width} period="all" trend={tone === "muted" ? "neutral" : tone} /> };
    }
    if (column.id === "change") {
      if (guide) return { text: directionLabel(guide.direction), color: toneColor(directionTone(guide.direction), colors), keepColorWhenSelected: guide.direction === "raised" || guide.direction === "cut" };
      const change = observationChange(row as KpiObservation, observations);
      return { text: changeText(change), value: change.value, color: toneColor(changeTone(row as KpiObservation, change.value), colors) };
    }
    const text = column.id === "metric" ? row.metric.name : column.id === "period" ? fiscalLabel(row) : column.id === "value" ? `${guide ? rangeText(guide) : observationValue(row as KpiObservation)}${guide?.status === "withdrawn" || guide?.hedge === "qualitative" ? "" : unitSuffix(row)}`
      : column.id === "unit" ? unitLabel(row)
      : column.id === "basis" ? basisLabel(row.basis) : column.id === "scope" ? dimensionLabel(row.dimensions) || "Consolidated"
      : column.id === "issued" ? guide?.issuedDate ?? "--" : column.id === "actual" ? guide?.actual ? `${valueText(row, guide.actual.value)}${unitSuffix(row)}` : "--"
      : column.id === "outcome" ? guide ? outcomeLabel(guide) : "--" : column.id === "published" ? row.evidence[0]!.publishedAt.slice(0, 10)
      : column.id === "confidence" ? `${Math.round(row.confidence * 100)}%` : column.id === "revision" ? `${row.revision} ${row.current ? "current" : "superseded"}` : row.evidence[0]!.quote;
    return { text, ...(column.id === "value" && !guide ? { value: exactObservation(row as KpiObservation) ? (row as KpiObservation).value : observationValue(row as KpiObservation) } : column.id === "actual" ? { value: guide?.actual?.value } : {}),
      color: column.id === "metric" ? colors.textBright : column.id === "value" || column.id === "actual" ? colors.textBright
        : column.id === "outcome" && guide?.actual ? guide.actual.favorable === "beat" ? colors.positive : guide.actual.favorable === "miss" ? colors.negative : colors.text
        : column.id === "period" || column.id === "basis" || column.id === "scope" || column.id === "issued" || column.id === "published" || column.id === "revision" || column.id === "confidence" ? colors.textDim : colors.text,
      keepColorWhenSelected: column.id === "outcome" && (guide?.actual?.favorable === "beat" || guide?.actual?.favorable === "miss") };
  };
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data && resource.error !== KPI_UNAVAILABLE ? resource.error : null}
      empty={!data && resource.error === KPI_UNAVAILABLE} emptyTitle={KPI_UNAVAILABLE} subject="company disclosures">
      {data ? <DataTableStackView<Item> focused={focused} rootWidth={width} rootHeight={bodyHeight} columns={columns} items={items} getItemKey={getId}
        selection={{ kind: "id", selectedId: selected?.id ?? null, getId, onChange: setSelected }}
        onActivate={(item) => item.row ? setOpen(item.row.id) : openUpgrade()} renderCell={renderCell} freezeFirstColumn selectedTextOverridesCellColor showHorizontalScrollbar
        detailOpen={!!openRow} onBack={() => setOpen(null)} detailTitle={openRow ? `${openRow.metric.name} · ${fiscalLabel(openRow)}` : undefined}
        detailScrollRef={detailScrollRef} detailContent={openRow ? <DetailScrollBody ref={detailScrollRef} resetScrollKey={openRow.id}><DisclosureEvidence row={openRow} sourceId={sourceId} onSource={setSource} width={width} /></DetailScrollBody> : null}
        sortColumnId={sort.column} sortDirection={sort.direction} onHeaderClick={(column) => setSort((previous) => ({ column, direction: previous.column === column && previous.direction === "desc" ? "asc" : "desc" }))}
        resetScrollKey={`${mode}:${symbol}:${tab}:${metric}:${activePlot}`}
        emptyStateTitle={tab === "history" ? "Actuals have not been matched to these guidance periods yet." : "No disclosed observations for this selection yet."}
        rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={items.length} tableColumns={columns} query={query}
          chart={tab === "chart" ? { series, ...(mode === "kpis" ? { xAxis: kpiChart.xAxis, viewport: kpiChart.viewport } : {}), empty: preview ? "Full history is available with Pro." : "History is accumulating. Two comparable disclosures are needed for a trend.",
            formatValue: (value) => selected ? `${valueText(selected, value)}${selected.currency ? ` ${unitLabel(selected)}` : ""}` : String(value),
            formatAxisValue: (value) => selected ? valueText(selected, value) : String(value), remoteKind: "company-disclosure-history", ...link } : null} />}
        bodyAfter={lockedCount && desktop ? <LockedOverlay rows={lockedCount} text="Upgrade for all disclosures and history" onPress={openUpgrade} /> : undefined}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
