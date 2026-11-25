import { publicTickerKey } from "../../../utils/exchanges";
import { getSharedRegistry } from "../../registry/shared";
import { useCallback, useMemo, useState } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import { usePlanAccess } from "../../../api-client/plan-access";
import type { SupplyChainPayload, SupplyOptions, SupplyRole, SupplyRow, SupplyTierFilter } from "../../../api-client/supply-chain";
import {
  Badge, buildSectionedRows, ChartTableHeader, DataTableView, EmptyState, formatPercentAxis, isSectionedItemRow, PageStackView, renderSectionedRowHeader, PaneStatusBody, QueryBar, StatGrid,
  statGridRows, useChartTableSelection, usePaneNoticeFooter, usePaneStatusFooter, usePaneTabs, type DataTableCell, type DataTableColumn, type PaneHint, type SectionedRow, type StatItem,
} from "../../../components";
import { staticSeries } from "../../../components/chart/static/series";
import { ClippedText } from "../../../components/ui/display";
import { RatioBar } from "../../../components/ui/ratio-bar";
import { getTableWidth, hiddenTableColumnRows, markHiddenTableColumns } from "../../../components/ui/table-layout";
import { chromeBarRows } from "../../../components/layout/pane/sizing";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../../ui";
import { MISSING_VALUE, displayWidth } from "../../../utils/format";
import { formatFilingDate } from "../../../utils/datetime-format";
import { SignInWall } from "../cloud/auth-actions";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { useOpenDescription } from "../shared/open-description";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedSupplyChain, loadSupplyChain, SUPPLY_UNAVAILABLE, validateSupplyChain } from "./client";
import { directoryColumns, directoryRows } from "./directories";
import { useSupplyEvidence } from "./evidence";
import { SupplyFlow } from "./flow";
import { SupplyGraphPane } from "./graph-pane";
import { entityTicker } from "./graph-model";
import {
  cellText, counterpartyKind, disclosureText, isTaggedFact, counterpartyKindLabel, counterpartyLabel, counterpartyLabelEnd, counterpartyName, disclosedValue, earlierRows, fitShareBasis, focusCompanyLabel, focusCompanyName, receivablesConcentration, lockedDisclosures, nativeValue, percentage, relationshipLabel, ROLE_COLORS, openingSupplyView, rowRoleLabel,
  periodDate, shareParts, sortRows, supplyEmptyText, supplyPreviewNote, supplyRoleCounts, type SupplySort,
} from "./model";
import { RowEvidence } from "./row-evidence";
import { DisclosureQuote } from "./disclosure-quote";
import { canShowQuote, evidenceDate, evidenceLabel, isUnconfirmed, matchesSupplyOptions, supplyOptions, TIER_OPTIONS } from "./trust";
import { logFailure } from "../../../utils/log-failure";

type Item = { kind: "edge"; row: SupplyRow } | { kind: "locked"; id: string };
const itemId = (item: Item) => item.kind === "edge" ? item.row.id : item.id;
const rowId = (row: SupplyRow) => row.id;
const formatShare = (value: number) => `${Number(value.toFixed(2))}%`;
const ROLE_PLURALS: Record<SupplyRole, string> = { customer: "Customers", supplier: "Suppliers", partner: "Partners", competitor: "Competitors", investee: "Investees" };
/** A share figure is at most five cells (`99.9%`, `100%`), right-aligned so the bars line up. */
const SHARE_FIGURE_CELLS = 5;
/** Bar, gap and figure: the least a share cell draws with its bar. */
const SHARE_BAR_MIN_CELLS = 3 + 1 + SHARE_FIGURE_CELLS;
/** Cells a column keeps for the bare basis of the longest row (`cost of sales`); a longer one is cut by an ellipsis. */
const SHARE_BASIS_FLOOR_CELLS = 13;
/** Cells of basis kept in the last resort: three letters and an ellipsis. */
const SHARE_BASIS_LAST_CELLS = 4;

/** Every row's basis as the cells of each form, whole wording first: what a share column is laid out by. */
type BasisForms = readonly (readonly number[])[];

/** Cells a row's basis keeps in `room`: its longest whole form that fits, else as much of its bare form as the floor allows. */
const keptBasis = (forms: readonly number[], room: number) => forms.find((cells) => cells <= room) ?? Math.min(room, SHARE_BASIS_FLOOR_CELLS);
/** The cells the narrowest column keeps for the longest bare basis. */
const bareBasis = (bases: BasisForms) => Math.min(SHARE_BASIS_FLOOR_CELLS, Math.max(0, ...bases.map((forms) => forms[forms.length - 1]!)));

/** Cells of a share column's bar and of its basis; no bar leaves the figure beside its basis. */
interface ShareLayout { bar: number; basis: number }

/**
 * The bar and the basis of a share column, the same on every row so the bars
 * and figures line up. A share keeps what it is a share of: the column gives
 * up the bar, then the whole wording, before it gives up the basis. The bar
 * takes what the longest basis leaves, between 3 and 8 cells.
 */
function shareLayout(width: number, bases: BasisForms): ShareLayout {
  const beside = width - SHARE_BAR_MIN_CELLS - 1;
  if (beside >= bareBasis(bases)) {
    const longest = Math.max(0, ...bases.map((forms) => keptBasis(forms, beside)));
    const bar = Math.min(width >= 36 ? 8 : 5, Math.max(3, width - SHARE_FIGURE_CELLS - 2 - longest));
    return { bar, basis: width - bar - SHARE_FIGURE_CELLS - 2 };
  }
  return { bar: 0, basis: Math.max(0, width - SHARE_FIGURE_CELLS - 1) };
}

/** The most a name column widens to keep its longest name whole. */
const NAME_KEEP_MAX_CELLS = 34;
/** A period end date ("31 Dec 2025"); its length, when the source states it, reads with it in a wider column. */
const PERIOD_DATE_CELLS = 11;
/**
 * Columns that fit the pane, giving up the least first: the share bar shortens
 * to keep the whole basis, the name shortens to 18 cells, the ticker folds into
 * the name and the period is left to the evidence view; then the share gives
 * its bar, then its whole wording for the bare basis, and the name shortens
 * further. A share never loses its basis. Only a pane narrower than that
 * scrolls sideways, so the pane edge never cuts a share in half.
 * Value shows only when some row discloses a value, retaining its original
 * currency and units.
 */
export function tableColumns(width: number, desktop: boolean, locked: boolean, valueWidth: number | null, bases: BasisForms, periodWidth = PERIOD_DATE_CELLS, nameCells = 0): DataTableColumn[] {
  const wide = width >= 150, medium = width >= 110;
  const name: DataTableColumn = { id: "name", label: "Counterparty", width: Math.max(locked && !desktop ? 34 : 0, wide ? 30 : medium ? 26 : 20), flexGrow: 1, align: "left" };
  // Wide enough for the longest whole wording beside its bar and figure ("27% of total revenue (gold sales)"), within a cap;
  // a narrow pane keeps its 26 cells, so the name keeps its room and the share reads its shorter basis.
  const whole = Math.max(0, ...bases.map((forms) => forms[0]!));
  // With no share on any row (a related-party table states amounts, not shares) the column keeps its header and the names take the room.
  const shareWidth = !bases.length ? SHARE_BAR_MIN_CELLS + 1
    : Math.max(wide ? 34 : medium ? 30 : 26, Math.min(wide ? 64 : medium ? 52 : 26, (wide ? 8 : 5) + SHARE_FIGURE_CELLS + 2 + whole));
  const share: DataTableColumn = { id: "pct", label: "Share", width: shareWidth, align: "left" };
  let columns: DataTableColumn[] = [
    name,
    // One kind of evidence for every row (filings alone) is no column; the filter names the kinds shown.
    { id: "evidence", label: "Evidence", width: 12, align: "left", omitWhenSame: true },
    // A listing as every function writes it: 000063:SZSE whole.
    ...(medium ? [{ id: "ticker", label: "Ticker", width: 11, align: "left" as const }] : []),
    { id: "role", label: "Role", width: 11, align: "left" },
    share,
    ...(valueWidth !== null ? [{ id: "usd", label: "Value", width: Math.max(medium ? 10 : 8, valueWidth), align: "right" as const }] : []),
    { id: "fy", label: "Period", width: periodWidth, align: "left" },
    ...(wide ? [
      // A day as the Period column writes it: 03 Nov 2026.
      { id: "filed", label: "Published", width: 11, align: "left" as const },
      // One publisher (the company's own filings) or one origin for every row is no column either.
      { id: "publisher", label: "Publisher", width: 16, align: "left" as const, omitWhenSame: true },
      { id: "corroboration", label: "Origins", width: 8, align: "right" as const, omitWhenSame: true },
    ] : []),
  ];
  const preferred = { share: share.width, name: name.width };
  // The table ignores its last trailing gutter when deciding whether it fits.
  const original = columns;
  const overflow = () => getTableWidth(columns) - width - 1;
  // Native units keep their column before the share keeps its bar or its whole wording.
  const withBar = SHARE_BAR_MIN_CELLS + 1;
  const plain = SHARE_FIGURE_CELLS + 1;
  const bare = bareBasis(bases);
  const shareFloor = withBar + (valueWidth !== null ? bare : Math.max(bare, ...bases.map((forms) => keptBasis(forms, preferred.share - withBar))));
  const fit = (shareMin: number, nameMin = 18) => {
    share.width = preferred.share; name.width = preferred.name;
    share.width = Math.max(shareMin, share.width - Math.max(0, overflow()));
    name.width = Math.max(nameMin, name.width - Math.max(0, overflow()));
  };
  // A name keeps what tells it apart before a share keeps the words after its basis: "Hon Hai Precision Industry" whole
  // beside "16% of total revenue", not "Hon Hai Precision In…" beside "…, from Compute & Networking", which the
  // selected row's own words and its evidence still say. Within a cap, so one long name never takes the table.
  const nameKeep = Math.min(NAME_KEEP_MAX_CELLS, Math.max(preferred.name, nameCells));
  const shareShort = withBar + (valueWidth !== null ? bare : Math.max(bare, ...bases.map((forms) => forms[Math.min(1, forms.length - 1)]!)));
  preferred.name = nameKeep;
  fit(shareFloor, nameKeep);
  if (overflow() > 0) fit(Math.min(shareFloor, shareShort), nameKeep);
  // A pane too narrow for both gives way as before: the name, then the columns, then the share's shorter forms.
  if (overflow() > 0) fit(shareFloor);
  for (const id of ["ticker", "fy"]) {
    if (overflow() <= 0) break;
    if (!columns.some((column) => column.id === id)) continue;
    columns = columns.filter((column) => column.id !== id);
    fit(shareFloor);
  }
  // The narrowest panes keep the figure and the bare basis, then a shorter name and a cut basis, before anything scrolls.
  const shares = bases.length > 0;
  if (overflow() > 0) fit(withBar + bare);
  if (overflow() > 0 && shares) fit(plain + bare);
  if (overflow() > 0) fit(shares ? plain + bare : SHARE_FIGURE_CELLS + 2, 12);
  if (overflow() > 0 && shares) fit(plain + SHARE_BASIS_LAST_CELLS, 12);
  return markHiddenTableColumns(original, columns);
}

/**
 * Company, then the counterparties per role on this tab, with how many
 * disclosures a free preview locks: the strip that heads the table and the flow.
 */
function supplyFigures(data: SupplyChainPayload, views: readonly ("says" | "names")[], options: Required<SupplyOptions>, company: string | null): StatItem[] {
  // Investee rows that all run into the company are its investors (rowRoleLabel).
  const stakes = views.flatMap((view) => data[view].filter((row) => row.role === "investee"));
  const investors = stakes.length > 0 && stakes.every((row) => row.direction === "in");
  return [
    ...(data.entity && company ? [{ id: "company", label: "Company", value: company }] : []),
    ...supplyRoleCounts(data, views, options).map(({ role, counterparties, locked }) => ({ id: role,
      label: role === "investee" && investors ? "Investors" : ROLE_PLURALS[role], value: String(counterparties),
      color: ROLE_COLORS[role], detail: locked ? `+${locked} locked` : undefined })),
  ];
}

/**
 * The share as a bar on a 0 to 100% scale, the figure, and what it is a share
 * of. The basis never goes: a column too narrow for the whole wording shows a
 * shorter form of it, then drops the bar, then cuts it behind an ellipsis.
 * The evidence view and the selected row's line say it whole.
 */
function ShareCell({ row, focusId, width, layout, selected }: { row: SupplyRow; focusId?: string; width: number; layout: ShareLayout; selected: boolean }) {
  const colors = useThemeColors();
  const share = shareParts(row, focusId);
  if (!share) return <Text fg={colors.textMuted}>{""}</Text>;
  const ink = selected ? colors.selectedText : colors.textBright;
  const basis = fitShareBasis(share, layout.basis);
  return <Box flexDirection="row" width={width} height={1} gap={1} overflow="hidden">
    {layout.bar ? <RatioBar ratio={row.pctOfRevenue! / 100} width={layout.bar} color={ROLE_COLORS[row.role]} track /> : null}
    <Text fg={ink} attributes={TextAttributes.BOLD}>{share.value.padStart(SHARE_FIGURE_CELLS)}</Text>
    {basis ? <Text fg={selected ? colors.selectedText : colors.textDim}>{basis}</Text> : null}
  </Box>;
}

/** Rows a table must leave free before the selected relationship's own words take them: a heading and a few lines of quote. */
const DISCLOSURE_BAND_MIN_ROWS = 8;

/**
 * The selected relationship's own words, in the rows a short table leaves
 * free, as a chart takes a short table's spare rows: the quote the row rests
 * on, or a tagged fact read out. Who said it and when are the row's own
 * columns; `e` opens the whole evidence.
 */
function SelectedDisclosure({ row, width, height }: { row: SupplyRow; width: number; height: number }) {
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const item = row.evidence?.find((entry) => entry.status === "active" && canShowQuote(entry) && entry.quote);
  const tagged = !item && isTaggedFact(row);
  // The terminal gives it the rows the table leaves; the desktop sets it under the last row at its own height.
  return <Box flexDirection="column" width={width} height={desktop ? undefined : height} flexShrink={desktop ? 0 : 1} minHeight={0} overflow="hidden" paddingX={desktop ? 0 : 1}
    data-gloom-role="supply-selected-disclosure">
    <DisclosureQuote role={row.role} quote={item?.quote ?? disclosureText(row)} quoteLanguage={item?.quoteLanguage ?? row.quoteLanguage}
      width={Math.max(1, width - (desktop ? 0 : 2))} label={tagged ? "Tagged in the filing" : undefined} />
  </Box>;
}

export function SupplyChainPane({ width, height, focused }: PaneProps) {
  const { symbol, ticker } = usePaneTickerIdentity();
  return <SupplyView key={symbol ?? "empty"} symbol={symbol} listingName={ticker?.metadata.name ?? null} width={width} height={height} focused={focused} />;
}
function SupplyView({ symbol, listingName, width, height, focused }: Pick<PaneProps, "width" | "height" | "focused"> & { symbol: string | null; listingName: string | null }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const openSource = (url: string) => {
    void host.openExternal(url).catch(logFailure("supply-chain.pane", "Open source document failed"));
  };
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const { createPaneFromTemplate } = usePluginAppActions();
  const openDescription = useOpenDescription();
  const session = useResearchCloudSession();
  const access = usePlanAccess();
  const accessKey = `${session.requestKey}:${access.hasProAccess ? "full" : "preview"}`;
  const openUpgrade = useCloudUpgradeAction("splc");
  const [snapshotSetting] = usePaneSettingValue<SupplyChainPayload | null>("supplySnapshot", null);
  const snapshot = useMemo(() => { try { return snapshotSetting ? validateSupplyChain(snapshotSetting) : null; } catch (error) { return logFailure("supply-chain.pane", "Validate supply chain snapshot failed", null)(error); } }, [snapshotSetting]);
  const [openingTab] = usePaneSettingValue("tab", "table");
  const [savedTab, setTab] = usePluginPaneState<string>("supply:tab", openingTab);
  const graphTab = savedTab === "graph" || savedTab === "path";
  const [openingTiers] = usePaneSettingValue("tiers", "sec,company,call");
  const initialTiers = useMemo(() => supplyOptions(openingTab === "graph" || openingTab === "path" ? undefined : openingTiers).tiers, [openingTiers, openingTab]);
  const [savedTiers, setTiers] = usePluginPaneState<SupplyTierFilter[]>("supply:tiers", initialTiers);
  const options = useMemo(() => supplyOptions(savedTiers), [savedTiers]);
  // `--as-of`: the disclosures known by that day, read by the server and never shown past it.
  const [asOfSetting] = usePaneSettingValue<string>("asOf", "");
  const read = useMemo(() => ({ ...options, ...asOfSetting ? { asOf: asOfSetting } : {} }), [options, asOfSetting]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadSupplyChain(symbol!, accessKey, force, read), [symbol, accessKey, snapshot, read]);
  const resource = useAsyncResource(symbol && !graphTab ? loader : null, {
    initialData: () => symbol ? cachedSupplyChain(symbol, accessKey, read) : null, clearOnError: isAccessDenied,
  });
  const data = resource.data?.payload ?? null;
  const [openingView] = usePaneSettingValue("view", "");
  const [savedView, setView] = usePluginPaneState<string>("supply:view", openingView);
  const view = savedView === "names" || savedView === "says" ? savedView : data ? openingSupplyView(data, options) : "says";
  const tooSmall = width < 70 || height < 13;
  const directories = data?.directories;
  const directoryTab = !!directories?.length && (savedTab === "directories" || savedTab === "table" && !data?.totalRows);
  const directoryItems = useMemo(() => directories?.flatMap(directoryRows) ?? [], [directories]);
  const [directoryId, setDirectoryId] = useState<string | null>(null);
  const selectedDirectory = directoryItems.find(row => row.id === directoryId) ?? directoryItems[0];
  const tab = directoryTab ? "directories" : graphTab ? savedTab : savedTab === "flow" && !tooSmall ? "flow" : "table";
  const [sort, setSort] = usePluginPaneState<SupplySort>("supply:sort", { column: "pct", direction: "desc" });
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`supply:selected:${view}`, null);
  const [openingEvidence] = usePaneSettingValue("evidence", false);
  const [openId, setOpen] = usePluginPaneState<string | null>("supply:evidence", null);
  const allRows = useMemo(() => data ? [...data.says, ...data.names].filter((row) => matchesSupplyOptions(row, options)) : [], [data, options]);
  const [flowIds, setFlowIds] = useState<string[]>([]);
  const rows = useMemo(() => data ? sortRows(data[view].filter((row) => matchesSupplyOptions(row, options)), sort) : [], [data, view, sort, options]);
  // Shares from before the reporter's latest period: their own section, never among the current rows or the flow.
  const earlier = useMemo(() => data ? sortRows(earlierRows(data, view).filter((row) => matchesSupplyOptions(row, options)), sort) : [], [data, view, sort, options]);
  const tableRows = useMemo(() => [...rows, ...earlier], [rows, earlier]);
  const selectionRows = tab === "flow" ? allRows.filter((row) => flowIds.includes(row.id)) : tableRows;
  const selected = tab === "flow" && selectedId?.startsWith("more:") ? null
    : selectionRows.find((row) => row.id === selectedId) ?? (tab === "flow" ? allRows.find((row) => row.id === flowIds[0]) : rows[0]) ?? null;
  const openRow = allRows.find((row) => row.id === openId) ?? earlier.find((row) => row.id === openId) ?? (openingEvidence && openId === null ? rows[0] : null) ?? null;
  useSupplyEvidence(graphTab ? null : data, tab, view, directoryTab ? directoryItems.map(row => row.id) : tab === "flow" ? flowIds : tableRows.map((row) => row.id), directoryTab ? null : openRow?.id ?? null, options.tiers);
  const locked = data?.truncated ? lockedDisclosures(data, [view]) : 0;
  const items = useMemo<SectionedRow<Item>[]>(() => buildSectionedRows<Item>([
    { label: "Relationships", items: rows.filter((row) => !isUnconfirmed(row)).map((row) => ({ kind: "edge", row })) },
    { label: "Unconfirmed", items: rows.filter(isUnconfirmed).map((row) => ({ kind: "edge", row })) },
    { label: "Earlier periods", items: earlier.map((row) => ({ kind: "edge", row })) },
    { label: "Pro", items: Array.from({ length: Math.min(3, locked) }, (_, i) => ({ kind: "locked", id: `locked:${i}` })) },
  ], itemId), [rows, earlier, locked]);
  const { strip, rows: tabRows } = usePaneTabs(symbol ? { tabs: [...(directories?.length && !data?.totalRows ? [] : [{ value: "table", label: "Table" }]), ...(directories?.length ? [{ value: "directories", label: "Supplier lists" }] : []), { value: "flow", label: "Flow", disabled: tooSmall }, { value: "graph", label: "Graph" }, { value: "path", label: "Path" }], activeValue: tab, onSelect: setTab, focused, dense: true } : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => resource.reload(), { focused: focused && !graphTab });
  const navigate = (row: SupplyRow, template = "supply-chain-pane") => {
    if (row.counterparty.ticker) createPaneFromTemplate(template, { symbol: publicTickerKey(row.counterparty.ticker, row.counterparty.exchange ?? undefined) });
    else setOpen(row.id);
  };
  const evidence = () => {
    if (!selected) return;
    setOpen(selected.id);
  };
  const current = openRow ?? selected;
  const hints: PaneHint[] = directoryTab && selectedDirectory ? [
    { id: "source", key: "o", label: "pen source", onPress: () => openSource(selectedDirectory.sourceUrl) },
    ...(directories?.some(report => report.total > report.entries.length) ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", onPress: openUpgrade }] : []),
  ] : [
    ...(current ? [{ id: "source", key: "o", label: "pen source", onPress: () => openSource(current.filingUrl) }] : []),
    ...(!openRow && selected ? [{ id: "evidence", key: "e", label: "vidence", onPress: evidence }] : []),
    ...(selected?.counterparty.ticker ? [
      { id: "description", key: "d", label: "es", onPress: () => openDescription(selected.counterparty.ticker!, selected.counterparty.exchange ?? undefined) },
      { id: "financials", key: "f", label: "a", onPress: () => navigate(selected, "financial-analysis-pane") },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: publicTickerKey(selected.counterparty.ticker!, selected.counterparty.exchange ?? undefined) }) },
      ...(getSharedRegistry()?.paneTemplates.has("buildout-pane") ? [{ id: "buildout", key: "t", label: "bo", onPress: () => createPaneFromTemplate("buildout-pane") }] : []),
    ] : []),
    ...(data?.truncated ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: openUpgrade }] : []),
  ];
  // Dated by the newest disclosure the reader can see, as its Published column says, never by the latest period one covers.
  const published = useMemo(() => allRows.map(evidenceDate).sort().at(-1) ?? null, [allRows]);
  usePaneStatusFooter({ registrationId: "supply-chain", enabled: !graphTab, loading: resource.loading, error: data ? resource.error : null, stale: resource.data?.stale,
    info: !directoryTab && published ? [{ id: "as-of", parts: [{ text: asOfSetting ? `known by ${asOfSetting}` : `as of ${published}`, tone: "muted" as const }] }] : [], hints });
  usePaneNoticeFooter({ registrationId: "supply-chain:notices", focused, enabled: !graphTab, notices: [
    ...(resource.data?.refreshError ? [resource.data.refreshError] : []),
    ...(savedTab === "flow" && tooSmall ? ["Flow needs a wider pane. Showing the table."] : []),
  ] });
  const focusId = data?.entity?.id;
  // Over the table, how much of the receivables one customer holds at each period end the company disclosed.
  const concentration = useMemo(() => tab === "table" && view === "says" ? receivablesConcentration(tableRows, focusId) : [], [tab, view, tableRows, focusId]);
  const concentrationDates = useMemo(() => new Map(concentration.map((point) => [point.rowId, point.date])), [concentration]);
  const getConcentrationDate = useCallback((row: SupplyRow) => concentrationDates.get(row.id) ?? null, [concentrationDates]);
  const chartSelection = useChartTableSelection({ rows: tableRows, getId: rowId, getDate: getConcentrationDate,
    selectedId: selected?.id ?? null, onSelect: setSelected, focused: focused && !openRow, enabled: concentration.length > 0 });
  const concentrationSeries = useMemo(() => [{ ...staticSeries(concentration.map((point) => ({ date: point.date, observedAt: point.date, value: point.pct })),
    { id: "receivables-concentration", label: "Largest disclosed customer · receivables", color: ROLE_COLORS.customer, calendarSpaced: true, style: "points" }), unit: "%", unitGroup: "percent" }], [concentration]);
  const concentrationChart = concentration.length ? { series: concentrationSeries, formatValue: formatShare, formatAxisValue: formatPercentAxis, strip: null, ...chartSelection } : null;
  const values = tableRows.filter((row) => nativeValue(row) !== null || row.usd !== null);
  const valueWidth = values.length ? Math.min(28, Math.max(...values.map((row) => displayWidth(disclosedValue(row).replace(/ (disclosed|derived)$/, ""))))) : null;
  const bases: BasisForms = tableRows.flatMap((row) => { const share = shareParts(row, focusId); return share ? [share.forms.map(displayWidth)] : []; });
  // The period's length follows its end date when the source states it (2026-07-31 half) and costs
  // no column; laid out a cell narrower, the table also clears its own scrollbar. Otherwise the
  // evidence view says it.
  const periodWidth = Math.max(PERIOD_DATE_CELLS, ...tableRows.map((row) => displayWidth(cellText(row, "fy"))));
  // What the longest name needs with its kind beside it ("Customer 1" and "undisclosed"), so the column can keep it whole.
  const nameCells = Math.max(0, ...tableRows.map((row) => {
    const kind = counterpartyKindLabel(row, true);
    return displayWidth(counterpartyLabel(row)) + (kind ? displayWidth(kind) + 4 : 0);
  }));
  const dated = tableColumns(width, desktop, locked > 0, valueWidth, bases, PERIOD_DATE_CELLS, nameCells);
  const lengths = periodWidth > PERIOD_DATE_CELLS ? tableColumns(width - 1, desktop, locked > 0, valueWidth, bases, periodWidth, nameCells) : null;
  const columns = lengths?.some((column) => column.id === "fy") && lengths.map((column) => column.id).join() === dated.map((column) => column.id).join() ? lengths : dated;
  const shareColumn = shareLayout(columns.find((column) => column.id === "pct")?.width ?? 0, bases);
  const renderCell = (entry: SectionedRow<Item>, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (!isSectionedItemRow(entry)) return { text: "" };
    const item = entry.item;
    if (item.kind === "locked") {
      if (!desktop && column.id === "name" && item.id === "locked:0") {
        const label = column.width >= 34 ? "Upgrade to see every relationship" : "Upgrade to Pro";
        return { text: label, content: <UpgradeLabel text={label} onPress={openUpgrade} role="supply-upgrade" />, onMouseDown: openUpgrade };
      }
      return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>{column.id === "name" ? "Additional relationship" : "Hidden"}</Text></Blurred> }
        : { text: "░".repeat(Math.min(8, column.width - 1)), color: colors.textDim };
    }
    const row = item.row;
    const ink = state.selected ? colors.selectedText : isUnconfirmed(row) ? colors.textDim : undefined;
    switch (column.id) {
      case "evidence": return { text: evidenceLabel(row), content: <Badge label={evidenceLabel(row)} tone={isUnconfirmed(row) ? "neutral" : "accent"} /> };
      case "filed": return { text: formatFilingDate(evidenceDate(row), MISSING_VALUE), value: evidenceDate(row), color: colors.textDim };
      case "publisher": return { text: cellText(row, "publisher"), color: colors.textDim };
      case "corroboration": return { text: String(row.corroboration ?? 1), value: row.corroboration ?? 1, color: colors.textDim, content: <Text fg={colors.textDim}>{row.corroboration ?? 1}</Text> };
      case "name": {
        const company = counterpartyKind(row) === "company";
        // The kind label never gives way to a long cohort name; a column too narrow for the name says it in its short form.
        // The desktop always says it short ("group", "related group"): the Role column beside it names the role, and the name takes the room.
        const full = counterpartyKindLabel(row);
        const kind = !desktop && full && displayWidth(counterpartyLabel(row)) + displayWidth(full) + 4 <= column.width ? full : counterpartyKindLabel(row, true);
        const ticker = !columns.some((entry) => entry.id === "ticker") ? entityTicker(row.counterparty) : null;
        const room = Math.max(8, column.width - (kind ? displayWidth(kind) + 4 : 0) - (ticker ? displayWidth(ticker) + 1 : 0));
        // On the desktop the name gives way at the column's edge by CSS and the ticker and kind keep their room.
        return { text: cellText(row, "name"), content: <Box flexDirection="row" height={1} gap={ticker ? 1 : 2} overflow="hidden" {...(desktop ? { flexShrink: 1, minWidth: 0 } : {})}>
          {/* A name cut short keeps the letter or number that tells two undisclosed customers apart ("Cu… 1"), in both renderers. */}
          <ClippedText fg={ink ?? (company ? colors.textBright : colors.textDim)} text={counterpartyLabel(row)} width={room} keepEnd={counterpartyLabelEnd(row)} />
          {ticker ? <Text fg={ink ?? colors.textDim} style={desktop ? { flex: "0 0 auto" } : undefined}>{ticker}</Text> : null}
          {kind ? desktop ? <Badge label={kind} /> : <Text fg={ink ?? colors.textMuted}>{kind}</Text> : null}
        </Box> };
      }
      case "ticker": {
        const ticker = entityTicker(row.counterparty);
        if (!ticker) return { text: "", value: null };
        return { text: ticker, color: colors.textBright, content: desktop ? <Badge label={ticker} tone="accent" /> : undefined };
      }
      // The text a copy or export reads names a related party; the cell draws the role beside the name's chip.
      case "role": return { text: relationshipLabel(row), content: <Box flexDirection="row" height={1} overflow="hidden">
        <Text fg={ROLE_COLORS[row.role]}>●</Text>
        <Text fg={ink ?? ROLE_COLORS[row.role]}>{` ${rowRoleLabel(row)}`}</Text>
      </Box> };
      case "pct": return { text: percentage(row) === MISSING_VALUE ? "" : `${shareParts(row, focusId)?.value ?? ""} ${shareParts(row, focusId)?.basis ?? ""}`.trim(), value: row.pctOfRevenue,
        content: <ShareCell row={row} focusId={focusId} width={column.width} layout={shareColumn} selected={state.selected} /> };
      case "usd": return nativeValue(row) === null && row.usd === null ? { text: "", value: null }
        : { text: disclosedValue(row).replace(/ (disclosed|derived)$/, ""), value: row.nativeAmount != null ? row.nativeAmount * (row.nativeScale ?? 1) : row.usd, color: colors.text };
      case "fy": return { text: displayWidth(cellText(row, "fy")) <= column.width ? cellText(row, "fy") : periodDate(row.period), color: colors.textDim };
      default: return { text: cellText(row, column.id) };
    }
  };
  if (!symbol) return <EmptyState title="Select a ticker." />;
  if (graphTab) return <Box width={width} height={height} flexDirection="column">{strip}<SupplyGraphPane symbol={symbol} tab={savedTab as "graph" | "path"} width={width} height={Math.max(3, height - tabRows)} focused={focused} /></Box>;
  if (!data && isCloudSessionRequired(resource.error)) return <SignInWall placement="supply-chain-signin" action="view supply chain disclosures" needsVerification={session.needsVerification} />;
  const bodyHeight = Math.max(3, height - tabRows);
  if (directoryTab && directories) {
    const columns = directoryColumns(directoryItems).map(([id, label, width]) => ({ id, label, width, align: "left" as const }));
    const meta = directories.map(report => report.buyer + " · " + (report.total > report.entries.length ? report.entries.length + " of " : "") + report.total + " entries").join(" · ");
    return <Box width={width} height={height} flexDirection="column">{strip}
      <DataTableView sortColumnId={null} sortDirection="asc" emptyStateTitle="No supplier entries." columns={columns} items={directoryItems} focused={focused} rootWidth={width} rootHeight={bodyHeight}
        rootBefore={<QueryBar width={width} filters={[]} meta={meta} />}
        selection={{ kind: "id", selectedId: selectedDirectory?.id ?? null, getId: row => row.id, onChange: setDirectoryId }}
        getItemKey={row => row.id} renderCell={(row, column) => {
          const value = row[column.id as keyof typeof row];
          return { text: (column.id === "observedAt" ? row.observedAt.slice(0, 10) : value) ?? "" };
        }} onActivate={row => openSource(row.sourceUrl)} freezeFirstColumn showHorizontalScrollbar />
    </Box>;
  }
  // A listing filed under its code (0700:HKEX) reads by its company's name.
  const company = focusCompanyName(data?.entity?.name, symbol, listingName);
  const focusLabel = focusCompanyLabel(symbol, company);
  const figures = data ? supplyFigures(data, tab === "flow" ? ["says", "names"] : [view], options, company) : [];
  const tierFilter = { id: "tiers", label: "Evidence", kind: "multi" as const, emptyLabel: "Primary", values: options.tiers, options: TIER_OPTIONS, onChange: (value: string[]) => { setTiers(supplyOptions(value).tiers); setSelected(null); setOpen(null); } };
  const query = <QueryBar width={width} filters={[{ id: "direction", label: "Direction", inline: true, value: view,
    options: [{ value: "says", label: `${focusLabel} says` }, { value: "names", label: `Names ${focusLabel}` }], onChange: (value: string) => { setView(value); setSelected(null); setOpen(null); } }, tierFilter]}
    meta={view === "names" ? "% of reporting company's basis" : undefined} />;
  // Without a trend the figures keep every row they had; the chart layout shares the height with the table only when it draws.
  const header = concentrationChart
    ? <ChartTableHeader width={width} height={bodyHeight} tableRows={items.length} tableColumns={columns} figures={figures} chart={concentrationChart} query={query} />
    : <Box flexDirection="column" flexShrink={0}>{query}<StatGrid items={figures} width={width} /></Box>;
  // The rows the table leaves free under its last row: the query bar, the figures, the column header and the rows,
  // and a scrollbar row a wide table may draw.
  const spareRows = bodyHeight - 1 - statGridRows(figures, width) - 1 - hiddenTableColumnRows(columns, items.length) - items.length - 1;
  const disclosureBand = tab === "table" && !concentrationChart && !openRow && selected && spareRows >= DISCLOSURE_BAND_MIN_ROWS
    ? <SelectedDisclosure row={selected} width={width} height={spareRows} /> : null;
  const flowFigureColumns = Math.min(Math.max(1, figures.length), Math.max(1, Math.floor(width / 24)));
  // A short flow keeps one row of figures, dropping the last roles, so the cards keep their room.
  const flowFigures = bodyHeight < 26 ? figures.slice(0, flowFigureColumns) : figures;
  const selectedShare = selected ? shareParts(selected, focusId) : null;
  const flowMeta = selected ? `${entityTicker(selected.reportingEntity) ?? selected.reportingEntity.name} ${evidenceLabel(selected)} · ${selectedShare ? `${selectedShare.value} ${selectedShare.basis}`
    : nativeValue(selected) !== null || selected.usd !== null ? disclosedValue(selected) : `${relationshipLabel(selected)}, no figure disclosed`}` : undefined;
  return <Box width={width} height={height} flexDirection="column">
    {strip}
    <PaneStatusBody loading={!data && resource.loading} error={!data && resource.error !== SUPPLY_UNAVAILABLE ? resource.error : null}
      empty={!data && resource.error === SUPPLY_UNAVAILABLE} emptyTitle={SUPPLY_UNAVAILABLE} subject="supply chain disclosures">
      {data ? <PageStackView focused={focused} detailOpen={!!openRow} onBack={() => setOpen("")} detailTitle={openRow ? counterpartyName(openRow) : undefined}
        detailContent={openRow ? <RowEvidence row={openRow} focusId={focusId} width={width} height={bodyHeight - 1} focused={focused} /> : null}
        rootContent={tab === "flow" ? <Box flexDirection="column" flexGrow={1} flexBasis={0} minHeight={0}>
          <QueryBar width={width} filters={[tierFilter]} meta={flowMeta} />
          <StatGrid items={flowFigures} width={width} columns={flowFigureColumns} />
          <SupplyFlow rows={allRows} symbol={symbol} focusName={data.entity ? company : null} focusId={focusId} width={width}
            height={Math.max(10, bodyHeight - chromeBarRows(desktop) - statGridRows(flowFigures, width, flowFigureColumns) - (data.truncated ? 1 : 0))} focused={focused && !openRow} selectedId={selectedId}
            onSelect={setSelected} onOpen={navigate} onVisible={setFlowIds} />
          {data.truncated ? <Box paddingX={1}><UpgradeLabel text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /></Box> : null}
        </Box> : <DataTableView<SectionedRow<Item>> columns={columns}
          items={items} focused={focused && !openRow} rootWidth={width} rootHeight={bodyHeight} rootBefore={header}
          // The selected row's words follow the table in the terminal's spare rows; on the desktop they follow its last row,
          // after the locked preview, and the table runs on to the footer below them.
          {...disclosureBand && !desktop ? { rootAfter: disclosureBand, fitRows: true, virtualize: false } : {}}
          selection={{ kind: "id", selectedId: selected?.id ?? null, getId: (entry) => entry.key, onChange: (id) => setSelected(id) }} getItemKey={(entry) => entry.key}
          isNavigable={isSectionedItemRow}
          // The placeholders stand for every locked disclosure; the header says what free shows and counts those, as the figures do.
          renderSectionHeader={(entry) => entry.kind === "section" && entry.label === "Pro" ? { text: supplyPreviewNote(data, locked) } : renderSectionedRowHeader(entry)}
          onActivate={(entry) => { if (isSectionedItemRow(entry)) entry.item.kind === "edge" ? navigate(entry.item.row) : openUpgrade(); }}
          renderCell={renderCell} sortColumnId={sort.column} sortDirection={sort.direction}
          onHeaderClick={(column) => setSort((old) => ({ column, direction: old.column === column && old.direction === "desc" ? "asc" : "desc" }))}
          selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${symbol}:${view}:${options.tiers.join(",")}`}
          emptyStateTitle={supplyEmptyText(data) ?? "No relationships for the selected evidence tiers."}
          bodyAfter={desktop && (locked > 0 || disclosureBand) ? <>
            {locked > 0 ? <LockedOverlay rows={Math.min(3, locked)} text="Upgrade to see every relationship" onPress={openUpgrade} role="supply-upgrade" /> : null}
            {disclosureBand}
          </> : undefined} />}
      /> : null}
    </PaneStatusBody>
  </Box>;
}
