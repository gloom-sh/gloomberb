import { useCallback, useMemo } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { CreditDocumentsPayload, CreditHeadroom, CreditInstrument, CreditScreenPayload, CreditScreenRow } from "../../../api-client/credit-documents";
import { ChartTableHeader, DataTableView, EmptyState, PageStackView, PaneStatusBody, QueryBar, useChartTableSelection, usePaneFooter, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableCell, type DataTableColumn, type PaneHint } from "../../../components";
import { formatCompactAxis } from "../../../components/chart-table";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedCredit, creditIssuerSymbol, CREDIT_UNAVAILABLE, fetchCreditScreen, loadCredit, validateCreditDocuments } from "./client";
import { CreditInstrumentDetail } from "./detail";
import { useCreditEvidence } from "./evidence";
import { HeadroomGauge } from "./gauge";
import { capitalCell, capitalColumns, capitalFigures, comparatorSymbol, covenantColumns, covenantUsage, CREDIT_TABS, creditAmount, covenantNumber, creditCurrencies, creditMaturityRows, creditPercent, creditTab, fieldLabel, headroomTone, instrumentOutstanding, isClosed, maturityAxis, maturityColumns, maturitySeries, maturityShares, NO_VALUE, screenColumns, screenRowId, sentence } from "./model";

type Row = { numbers?: Record<string, number | null>; id: string; values: Record<string, string>; instrumentId?: string; covenant?: CreditHeadroom; screen?: CreditScreenRow; year?: number; locked?: boolean; closed?: boolean };
const rowId = (row: Row) => row.id;
/** Cells a footer hint takes: `[k]label` and the space before it. */
const hintCells = (hint: PaneHint) => hint.key.length + hint.label.length + 3;

export function CreditDocumentsPane(props: PaneProps) {
  const { symbol } = usePaneTickerIdentity();
  const session = useResearchCloudSession(), access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  return <CreditView key={`${symbol}:${accessKey}`} {...props} symbol={symbol} accessKey={accessKey} needsVerification={session.needsVerification} />;
}
function CreditView({ symbol, width, height, focused, accessKey, needsVerification }: PaneProps & { symbol: string | null; accessKey: string; needsVerification: boolean }) {
  const colors = useThemeColors(), desktop = !!useUiCapabilities().nativePaneChrome;
  const { createPaneFromTemplate } = usePluginAppActions();
  const openUpgrade = useCloudUpgradeAction("crdoc");
  const [openingTab] = usePaneSettingValue("tab", "capital");
  const [savedTab, setTab] = usePluginPaneState<string>("credit:tab", openingTab);
  const tab = creditTab(savedTab);
  const [openingInstrument] = usePaneSettingValue<string | null>("instrument", null);
  const [openId, setOpen] = usePluginPaneState<string | null>("credit:instrument", openingInstrument);
  const [openingView] = usePaneSettingValue("view", "terms");
  const [view, setView] = usePluginPaneState<string>("credit:view", openingView);
  const [headroomSetting] = usePaneSettingValue("headroom", 20);
  const [headroom, setHeadroom] = usePluginPaneState<number>("credit:headroom", headroomSetting);
  const [monthsSetting] = usePaneSettingValue("months", 12);
  const [months, setMonths] = usePluginPaneState<number>("credit:months", monthsSetting);
  const [currency, setCurrency] = usePluginPaneState<string>("credit:currency", "");
  const [sort, setSort] = usePluginPaneState<{column: string | null; direction: "asc" | "desc"}>(`credit:sort:${tab}`, {column: tab === "maturities" ? "year" : null, direction: "asc"});
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`credit:selected:${tab}`, null);
  const [snapshotSetting] = usePaneSettingValue<CreditDocumentsPayload | null>("creditSnapshot", null);
  const [screenSnapshot] = usePaneSettingValue<CreditScreenPayload | null>("creditScreenSnapshot", null);
  const [instrumentSnapshot] = usePaneSettingValue<CreditInstrument | null>("creditInstrumentSnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateCreditDocuments(snapshotSetting, symbol ? creditIssuerSymbol(symbol) : undefined) : null; } catch { return null; } }, [snapshotSetting, symbol]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadCredit(symbol!, accessKey, force), [symbol, accessKey, snapshot]);
  const resource = useAsyncResource(symbol ? loader : null, { initialData: () => symbol ? cachedCredit(symbol, accessKey) : null, clearOnError: isAccessDenied });
  const data = resource.data?.payload ?? null;
  const screenLoader = useCallback(() => screenSnapshot ? Promise.resolve(screenSnapshot) : fetchCreditScreen({ headroomBelow: headroom, springingWithinMonths: months, limit: 100 }), [screenSnapshot, headroom, months, accessKey]);
  const screen = useAsyncResource(tab === "screen" ? screenLoader : null, { clearOnError: isAccessDenied });
  const screenData = screen.data;
  const currencies = data ? creditCurrencies(data) : [];
  const selectedCurrency = currencies.includes(currency) ? currency : currencies[0] ?? "";
  const maturityRows = useMemo(() => data ? creditMaturityRows(data, selectedCurrency) : [], [data, selectedCurrency]);
  const series = useMemo(() => maturitySeries(maturityRows, selectedCurrency, colors.warning), [maturityRows, selectedCurrency, colors.warning]);
  const preview = data?.access === "preview";
  const columns = useMemo<DataTableColumn[]>(() => tab === "capital" ? data ? capitalColumns(data, width) : [] : tab === "covenants" ? covenantColumns(width)
    : tab === "maturities" ? maturityColumns(width, preview) : screenColumns(width), [tab, data, width, preview]);
  const figures = useMemo(() => tab === "capital" && data ? capitalFigures(data) : [], [tab, data]);
  const unsortedRows = useMemo<Row[]>(() => {
    if (tab === "screen") return (screenData?.rows ?? []).map((row) => ({ id: screenRowId(row), instrumentId: row.instrumentId, screen: row, numbers: {value:row.value}, values: { symbol: row.symbol, kind: row.kind === "springing_maturity" ? "Springing maturity" : row.value != null && row.value < 0 ? "Breach" : "Low headroom", value: creditPercent(row.value), date: row.date ?? NO_VALUE, instrument: row.instrumentName, reason: sentence(row.reason) } }));
    if (!data) return [];
    if (tab === "capital") return data.instruments.map((row) => ({ id: row.id, instrumentId: row.id, closed: isClosed(row), numbers: {principal:instrumentOutstanding(row)}, values: Object.fromEntries(["name", "facility", "coupon", "maturity", "principal", "currency", "ranking", "control"].map((id) => [id, capitalCell(row, id, data)])) }));
    if (tab === "covenants") return data.covenants.map((row) => { const fact=data.instruments.find((item) => item.id === row.instrumentId)?.facts.find((item) => item.id === row.id); return ({ id: row.id, instrumentId: row.instrumentId, covenant: row, numbers: {headroom:row.headroomPercent,usage:covenantUsage(row),threshold:row.threshold,current:row.current}, values: { metric: sentence(row.metric), headroom: creditPercent(row.headroomPercent), usage: "", threshold: `${comparatorSymbol(row.comparator, row.inclusive)} ${covenantNumber(row.threshold,fact)}`, current: covenantNumber(row.current,fact), status: fieldLabel(row.status), date: row.asOf, instrument: row.instrumentName } }); });
    const shares = preview ? new Map() : maturityShares(maturityRows);
    return maturityRows.flatMap((row) => row.instruments.map((instrument) => { const id = `${row.year}:${instrument.id}`, share = shares.get(id); return { id, instrumentId: instrument.id, year: row.year, numbers: {year:row.year,principal:instrument.principal,share:share?.share ?? null,cumulative:share?.cumulative ?? null}, values: { year: String(row.year), principal: creditAmount(instrument.principal), share: creditPercent(share?.share), cumulative: creditPercent(share?.cumulative), instruments: instrument.name } }; }));
  }, [data, screenData, tab, maturityRows, preview]);
  const rows = useMemo(() => !sort.column ? unsortedRows : [...unsortedRows].sort((a,b) => {
    const column=sort.column!;
    const left=a.numbers && column in a.numbers ? a.numbers[column] : a.values[column]?.toLowerCase();
    const right=b.numbers && column in b.numbers ? b.numbers[column] : b.values[column]?.toLowerCase();
    return left == null || right == null ? left == right ? a.id.localeCompare(b.id) : left == null ? 1 : -1
      : left === right ? a.id.localeCompare(b.id) : (left < right ? -1 : 1)*(sort.direction === "asc" ? 1 : -1);
  }),[unsortedRows,sort]);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const screenOpen = rows.find((row) => row.id === openId)?.screen;
  const openInstrument = data?.instruments.find((row) => row.id === openId) ?? (screenOpen ? { id: screenOpen.instrumentId, key: screenOpen.instrumentId, name: screenOpen.instrumentName, currency: screenOpen.currency, facilityType: null, principal: null, commitment: null, drawn: null, maturity: null, facts: screenOpen.evidence } : null);
  const [initialFact] = usePaneSettingValue<string | null>("fact", null);
  const [openFactId, setOpenFact] = usePluginPaneState<string | null>(`credit:fact:open:${openInstrument?.id ?? "none"}`, initialFact);
  const activeSymbol = screenOpen?.symbol ?? symbol;
  const activeCovenant = tab === "covenants" ? data?.covenants.find((row) => row.id === selected?.id && row.instrumentId === openInstrument?.id) ?? null : null;
  const locked = tab === "screen" ? screenData?.lockedRows ?? 0 : data?.lockedRows ?? 0;
  const items = useMemo<Row[]>(() => [...rows, ...Array.from({ length: Math.min(3, locked) }, (_, index) => ({ id: `locked:${index}`, values: {}, locked: true }))], [rows, locked]);
  const { strip, rows: tabRows } = usePaneTabs({ tabs: [...CREDIT_TABS], activeValue: tab, onSelect: (value) => { setTab(value); setOpen(null); }, focused: focused && !openInstrument, dense: true });
  const bodyHeight = Math.max(3, height - tabRows);
  const link = useChartTableSelection({ rows: rows.filter((row) => row.year !== undefined), getId: rowId, getDate: (row) => new Date(Date.UTC(row.year!, 0, 1)), selectedId: selected?.id ?? null, onSelect: setSelected, focused: focused && !openInstrument, enabled: tab === "maturities" });
  useAutoRefresh(resource.updatedAt, resource.load);
  useAutoRefresh(screen.updatedAt, screen.load);
  usePaneRefreshKey(() => { void resource.reload(); if (tab === "screen") void screen.reload(); }, { focused });
  const currentError = tab === "screen" ? screen.error : resource.error;
  const available = tab === "screen" ? !!screenData : !!data;
  const loading = tab === "screen" ? screen.loading : resource.loading;
  const target = activeSymbol ?? symbol ?? "";
  const allHints: PaneHint[] = [
    ...(symbol ? [
      { id: "credit:des", key: "d", label: "es", title: "Description (DES)", onPress: () => createPaneFromTemplate("new-ticker-detail-pane", { symbol: target }) },
      { id: "credit:fa", key: "f", label: "a", title: "Financial analysis (FA)", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: target }) },
      { id: "credit:graph", key: "g", label: "raph", title: "Price chart (G)", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: target }) },
      { id: "credit:ddis", key: "m", label: "aturities", title: "DDIS maturity schedule", onPress: () => createPaneFromTemplate("debt-maturities-pane", { symbol: target }) },
      { id: "credit:cds", key: "c", label: "ds", title: "CDS trades", onPress: () => createPaneFromTemplate("cds-pane", { symbol: target }) },
    ] : []),
    ...(locked || preview ? [{ id: "credit:upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  const asOf = tab === "screen" ? screenData?.asOf : data?.asOf;
  const notices = [...(data?.warnings ?? []), ...(resource.data?.refreshError ? [resource.data.refreshError] : []), ...(screenData?.truncated ? ["Screen results reached the result limit; narrow the thresholds."] : [])];
  // A narrow footer keeps the upgrade and the first links; the rest stay bound
  // and move to the pane menu, so the status on the left never gets cut.
  const footerBudget = width - 2 - (asOf ? 17 : 0) - (notices.length ? 5 : 0) - (openInstrument ? 14 : 0);
  const { shown: hints, folded } = useMemo(() => {
    const keep = new Set(allHints.map((hint) => hint.id));
    let used = allHints.reduce((total, hint) => total + hintCells(hint), 0);
    for (const hint of [...allHints].reverse()) {
      if (used <= footerBudget) break;
      if (hint.id === "credit:upgrade") continue;
      keep.delete(hint.id);
      used -= hintCells(hint);
    }
    return { shown: allHints.filter((hint) => keep.has(hint.id)), folded: allHints.filter((hint) => !keep.has(hint.id)) };
  }, [allHints.map((hint) => hint.id).join(), footerBudget, target, openUpgrade, createPaneFromTemplate]);
  usePaneStatusFooter({ registrationId: "credit-documents", loading, error: available ? currentError : null, stale: resource.data?.stale,
    info: asOf ? [{ id: "as-of", parts: [{ text: `as of ${asOf.slice(0, 10)}`, tone: "muted" as const }] }] : [], hints });
  usePaneFooter("credit:folded", () => folded.length ? { keys: folded, menu: folded.map((hint) => ({ id: `credit:menu:${hint.id}`, label: hint.title ?? hint.label, accelerator: hint.key, onSelect: () => hint.onPress?.() })) } : null, [folded]);
  usePaneNoticeFooter({ registrationId: "credit:notices", focused, notices });
  useCreditEvidence(data, screenData ?? null, instrumentSnapshot, tab, view, rows.map(rowId), openInstrument?.id ?? null, openFactId);
  if (!symbol) return <EmptyState title="Select an issuer ticker." />;
  if (!available && isCloudSessionRequired(currentError)) return <SignInWall placement="credit-documents-signin" action="view credit documents" needsVerification={needsVerification} />;
  const query = tab === "screen" ? <QueryBar width={width} filters={[
    { id: "headroom", label: "Headroom below", value: String(headroom), options: [0, 10, 20, 30, 50, 100].map((value) => ({ value: String(value), label: `${value}%` })), onChange: (value) => setHeadroom(Number(value)) },
    { id: "springing", label: "Springing within", value: String(months), options: [3, 6, 12, 24, 36].map((value) => ({ value: String(value), label: `${value} months` })), onChange: (value) => setMonths(Number(value)) },
  ]} /> : tab === "maturities" ? <QueryBar width={width} filters={currencies.length ? [{ id: "currency", label: "Currency", value: selectedCurrency, options: currencies.map((value) => ({ value, label: value })), onChange: setCurrency }] : []} /> : undefined;
  const rootBefore = tab === "maturities" ? <ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns} query={query}
    chart={series.length ? { series, formatValue: creditAmount, formatAxisValue: formatCompactAxis, cursorDate: link.cursorDate, onCursorDateChange: link.onCursorDateChange, remoteKind: "credit-maturity-wall", xAxis: maturityAxis(maturityRows), onActivate: link.onActivate } : null} />
    : tab === "capital" && figures.length ? <ChartTableHeader width={width} height={bodyHeight} tableRows={items.length} tableColumns={columns} figures={figures} /> : query;
  const lockedText = tab === "screen" ? "Upgrade to see every signal" : "Upgrade to see all terms";
  // The terminal prompt sits in the widest column so it is never cut.
  const lockedColumn = columns.find((column) => column.flexGrow)?.id ?? columns[0]?.id;
  const renderCell = (row: Row, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (row.locked) return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === lockedColumn ? tab === "screen" ? "Additional signal" : "Additional credit document" : "Hidden"}</Text></Blurred> }
      : { text: column.id === lockedColumn && row.id === "locked:0" ? lockedText : "░░░░", color: colors.textDim, ...(column.id === lockedColumn && row.id === "locked:0" ? { content: <UpgradeLabel text={lockedText} onPress={openUpgrade} /> } : {}) };
    if (column.id === "usage" && row.covenant) return { text: "", content: <HeadroomGauge covenant={row.covenant} width={column.width} selected={state.selected} /> };
    const text = row.values[column.id] ?? "";
    const number = row.numbers?.[column.id];
    const value = column.align === "right" && row.numbers && column.id in row.numbers ? number ?? null : undefined;
    if (text === NO_VALUE) return { text, value, color: colors.textMuted };
    if (row.closed) return { text, value, color: colors.textDim };
    if (column.id === "headroom" && row.covenant) {
      const tone = headroomTone(row.covenant);
      return { text, value, color: tone ? colors[tone] : colors.textBright, keepColorWhenSelected: !!tone };
    }
    if (column.id === "value" && row.screen?.kind === "headroom") {
      const tone = row.screen.value == null ? undefined : headroomTone({ headroomPercent: row.screen.value, status: row.screen.value < 0 ? "breach" : "compliant" });
      return { text, value, color: tone ? colors[tone] : colors.text, keepColorWhenSelected: !!tone };
    }
    if (column.id === "status" && row.covenant) {
      const breach = row.covenant.status === "breach";
      return { text, color: breach ? colors.negative : colors.textDim, keepColorWhenSelected: breach };
    }
    return { text, value, color: column.id === columns[0]!.id ? colors.textBright : colors.text };
  };
  return <Box width={width} height={height} flexDirection="column">{strip}
    <PaneStatusBody loading={!available && loading} error={!available && currentError !== CREDIT_UNAVAILABLE ? currentError : null}
      empty={!available && currentError === CREDIT_UNAVAILABLE} emptyTitle={CREDIT_UNAVAILABLE} subject="credit documents">
      {available ? <PageStackView focused={focused && !openFactId} detailOpen={!!openInstrument} onBack={() => setOpen(null)} detailTitle={openInstrument?.name}
        detailContent={openInstrument && activeSymbol ? <CreditInstrumentDetail key={`${activeSymbol}:${openInstrument.id}`} symbol={activeSymbol} instrument={openInstrument} width={width} height={bodyHeight - 1} focused={focused} accessKey={accessKey} view={view} setView={setView} covenant={activeCovenant} openId={openFactId} setOpen={setOpenFact} captured={instrumentSnapshot?.id === openInstrument.id ? instrumentSnapshot : null} pro={data?.access === "full"} onUpgrade={openUpgrade} /> : null}
        rootContent={<DataTableView<Row> columns={columns} items={items} sortColumnId={sort.column} sortDirection={sort.direction} onHeaderClick={(column) => setSort((current) => ({column,direction:current.column === column && current.direction === "asc" ? "desc" : "asc"}))} focused={focused && !openInstrument} rootWidth={width} rootHeight={bodyHeight} rootBefore={rootBefore}
          getItemKey={rowId} selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelected }}
          onActivate={(row) => row.locked ? openUpgrade() : setOpen(row.screen ? row.id : row.instrumentId ?? null)}
          renderCell={renderCell}
          emptyStateTitle={tab === "screen" ? "No supported credit signals match these thresholds." : tab === "covenants" ? "No financial maintenance covenants documented." : tab === "maturities" ? "No supported instrument maturity amounts." : CREDIT_UNAVAILABLE}
          emptyStateHint={tab === "screen" && (headroom < 100 || months < 36) ? "Raise either threshold to widen the screen." : undefined}
          selectedTextOverridesCellColor showHorizontalScrollbar freezeFirstColumn resetScrollKey={`${symbol}:${tab}:${selectedCurrency}`}
          bodyAfter={locked > 0 && desktop ? <LockedOverlay rows={Math.min(3, locked)} text={lockedText} onPress={openUpgrade} /> : undefined} />} /> : null}
    </PaneStatusBody>
  </Box>;
}
