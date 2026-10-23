import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import type { HiringSignalGroup, HiringSignalsFilter, HiringWeekSignal } from "../../../api-client/hiring";
import { ChartTableHeader, DataTableView, PageStackView, PaneFooterScope, PaneLinkMenu, QueryBar, usePagedRows, usePaneStatusFooter, useTableLoadMore, withCountryFlag, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { DetailReader, type DetailFact } from "../../../components/reader/detail-reader";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { useOpenDescription } from "../shared/open-description";
import { listingCell, missingCell, signedColor, toneColor, withoutQuietColumns } from "../shared/research-cells";
import { cachedSignals, fetchSignals, loadSignals, validateSignals, type SignalsPayload } from "./client";
import { sortAttentionRows } from "./model";
import { companySignalsModel, isSignalsFilter, isSignalsView, signalFacts, signalsBoardModel, signalsNumber, SIGNAL_FILTERS, SIGNALS_SIGNED_COLUMNS, SIGNALS_VIEWS, type SignalsRow } from "./signals-model";

const rowId = (row: SignalsRow) => row.id;
const locked = (row: SignalsRow) => row.id.startsWith("locked:");
/** A board with no first, or a company with no spike, leaves those columns out. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { prior: [""], since: [""], mean: [""], pace: [""], z: [""], companyPace: [""], title: [""] };
/** Postings a signal's detail links to, so the sentence after them stays in view; the Postings view lists them all. */
const DETAIL_POSTINGS = 3;

export interface HiringSignalsViewProps {
  group: HiringSignalGroup;
  symbol?: string;
  width: number;
  height: number;
  focused: boolean;
  /** Plan and session, so a cached read is never shown to the wrong account. */
  accessKey: string;
  /** The board opens a company on the same tab, as Moves does. */
  company?: { open: string | null; onOpen: (symbol: string | null) => void; render: (symbol: string, width: number, height: number) => ReactNode };
}

/**
 * HIRE's Expansion and Anomalies tabs. Alone, the latest week's signals of
 * the group: Enter opens the company, `e` says why. On a ticker, the
 * company's own signals of the group, this week's and earlier, and the
 * postings behind this week's, each linking to the employer's page.
 */
export function HiringSignalsView({ group, symbol, width, height, focused, accessKey, company }: HiringSignalsViewProps) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const openDescription = useOpenDescription();
  const upgrade = useCloudUpgradeAction("hire");
  const scope = `hiring:${group}:${symbol ?? "board"}`;
  const [openingFilter] = usePaneSettingValue<string>("signalsKind", "all");
  const [storedFilter, setFilter] = usePluginPaneState<string>(`hiring:${group}:filter`, openingFilter);
  const filter: HiringSignalsFilter = isSignalsFilter(group, storedFilter) ? storedFilter : "all";
  const [openingView] = usePaneSettingValue<string>("signalsView", "signals");
  const [storedView, setView] = usePluginPaneState<string>(`${scope}:view`, openingView);
  const view = isSignalsView(storedView) ? storedView : "signals";
  const [snapshotSetting] = usePaneSettingValue<SignalsPayload | null>(`${group}Snapshot`, null);
  // A `gloom shot` hands the payload in; a company opened from a board snapshot still loads its own.
  const snapshot = useMemo(() => {
    try {
      const payload = snapshotSetting ? validateSignals(snapshotSetting) : null;
      return payload && ("group" in payload ? !symbol && payload.group === group : payload.symbol.toUpperCase() === symbol?.toUpperCase()) ? payload : null;
    } catch { return null; }
  }, [snapshotSetting, symbol, group]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadSignals(group, symbol, accessKey, filter, force), [snapshot, group, symbol, accessKey, filter]);
  const resource = useAsyncResource(loader, { initialData: () => cachedSignals(group, symbol, accessKey, filter), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  const model = useMemo(() => !data ? null : "group" in data ? signalsBoardModel(data, filter) : companySignalsModel(data, group), [data, filter, group]);
  const sectionId = symbol ? view : "board";
  const section = model?.sections[sectionId];
  const pageLoader = useCallback(async ({ offset, signal }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const payload = offset === 0 && data ? data : await fetchSignals(group, undefined, { filter, offset, limit: 100 }, undefined, signal);
    if (!("group" in payload)) return { rows: [], hasMore: false, nextOffset: null };
    const next = !payload.preview && offset + payload.signals.length < payload.total ? offset + payload.signals.length : null;
    return { rows: signalsBoardModel(payload, filter).sections.board!.rows, hasMore: !snapshot && next !== null, nextOffset: next };
  }, [data, group, filter, snapshot]);
  const paged = usePagedRows(data && !symbol ? pageLoader : null, { getId: rowId });
  const sectionRows = !symbol && paged.status !== "idle" ? paged.rows : section?.rows ?? [];
  // The board keeps the server's order (unflagged first, the largest rises first) until a header is clicked.
  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" } | null>(`${scope}:${sectionId}:sort`, null);
  const lockedRows = Math.min(3, section?.locked ?? 0);
  const upgradeText = symbol ? "Upgrade for all signals" : `Upgrade for all ${group === "expansion" ? "expansion" : "anomaly"} signals`;
  const rows = useMemo(() => [...(sort ? sortAttentionRows(sectionRows, sort.column, sort.direction) : sectionRows) as SignalsRow[],
    ...Array.from({ length: lockedRows }, (_, index): SignalsRow => ({ id: `locked:${index}`, values: {} }))], [sectionRows, sort, lockedRows]);
  const dataRows = useMemo(() => rows.filter((row) => !locked(row)), [rows]);
  const columns = useMemo(() => !section ? [] : withoutQuietColumns(section.columns, dataRows, (row, id) => row.values[id] ?? "", QUIET_COLUMNS), [section, dataRows]);
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`${scope}:${sectionId}:selected`, null);
  const openCompany = company?.open ?? null;
  const [openRowId, setOpenRow] = usePluginPaneState<string | null>(`${scope}:open`, null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const opened = dataRows.find((row) => row.id === openRowId) ?? null;
  const detailOpen = !!openCompany || !!opened;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollMore = useTableLoadMore(scrollRef, paged.hasMore && !detailOpen, paged.loadMore);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); paged.reload(); }, { focused: focused && !detailOpen });

  const subject = selected?.symbol ?? symbol;
  // A signal opens its first posting; a posting row its own.
  const sourceRow = opened ?? selected;
  const source = sourceRow?.jobPosting?.url ?? sourceRow?.signal?.postings[0]?.url ?? null;
  const hints: PaneHint[] = [
    ...(source ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(source) }] : []),
    // On a company Enter already opens a signal or a posting.
    ...(!symbol && selected?.signal && !opened ? [{ id: "evidence", key: "e", label: "vidence", title: "Why it fired", onPress: () => setOpenRow(selected.id) }] : []),
    ...(subject && !opened ? [
      { id: "description", key: "d", label: "es", onPress: () => openDescription(subject) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: subject }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: subject }) },
      { id: "related", key: "a", label: "pps", title: "App attention", onPress: () => createPaneFromTemplate("apps-pane", { symbol: subject }) },
    ] : []),
    ...(model?.preview ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: `${scope}:status`, enabled: !openCompany, loading: resource.loading || paged.loadingMore, error: data ? resource.error ?? paged.moreError?.message ?? paged.error?.message : null, stale: resource.data?.stale,
    info: [...(model?.asOf ? [{ id: "observed", asOf: true, parts: [{ text: `as of ${model.asOf.slice(0, 10)}`, tone: "muted" as const }] }] : []), ...(model?.preview ? [{ id: "preview", parts: [{ text: "Pro preview", tone: "warning" as const }] }] : [])], hints });

  const query = <QueryBar width={width} filters={symbol
    ? [{ id: "view", label: "View", value: view, options: SIGNALS_VIEWS.map((entry) => ({ ...entry })), onChange: (value: string) => { setView(value); setOpenRow(null); } }]
    : [{ id: "kind", label: "Show", value: filter, defaultValue: "all", options: SIGNAL_FILTERS[group].map((entry) => ({ ...entry })), onChange: (value: string) => { setFilter(value); setOpenRow(null); } }]} />;
  const signalDetail = (signal: HiringWeekSignal): DetailFact[] => [
    ...signalFacts(signal),
    // The postings behind it, each opening the employer's page.
    ...signal.postings.slice(0, DETAIL_POSTINGS).map((posting, index): DetailFact => ({ label: index === 0 ? "Postings" : "", value: `${posting.title.trim()}${posting.location ? `, ${posting.location}` : ""}`,
      ...(posting.url ? { link: { label: "Open posting", onOpen: () => void host.openExternal(posting.url!) } } : {}) })),
    ...(signal.postings.length > DETAIL_POSTINGS ? [{ label: "", value: `${signal.postings.length - DETAIL_POSTINGS} more in ${symbol ? "the" : "the company's"} Postings view` }] : []),
  ];
  const detailTitle = openCompany ?? (opened?.jobPosting ? opened.jobPosting.title.trim() : opened?.signal ? `${opened.signal.symbol} · ${opened.signal.label}` : undefined);
  const detail = openCompany && company ? <PaneFooterScope active>{company.render(openCompany, width, height - 1)}</PaneFooterScope>
    : opened ? <PaneLinkMenu><DetailReader resetScrollKey={opened.id} width={width}
      facts={opened.jobPosting ? opened.details ?? [] : opened.signal ? signalDetail(opened.signal) : []} body={opened.jobPosting ? null : opened.signal?.why ?? null} note={opened.jobPosting?.url ?? null} /></PaneLinkMenu> : null;
  return <PageStackView focused={focused} detailOpen={detailOpen} onBack={() => { company?.onOpen(null); setOpenRow(null); }} detailTitle={detailTitle} detailContent={detail}
    rootContent={<DataTableView columns={columns} items={model && section ? rows : []} rootWidth={width} rootHeight={height} focused={focused && !detailOpen} scrollRef={scrollRef} onBodyScrollActivity={scrollMore}
      status={!data ? { loading: resource.loading, error: resource.error, subject: "hiring signals" } : undefined}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns} query={query} figures={model?.figures} />}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelected }} getItemKey={rowId}
      sortColumnId={sort?.column ?? null} sortDirection={sort?.direction ?? "desc"} onHeaderClick={(column) => setSort((old) => ({ column, direction: old?.column === column && old.direction === "desc" ? "asc" : "desc" }))}
      onActivate={(row) => locked(row) ? void upgrade() : !symbol && row.symbol && company ? company.onOpen(row.symbol) : row.signal || row.jobPosting ? setOpenRow(row.id) : undefined}
      renderCell={(row, column, _index, state) => {
        if (locked(row)) {
          if (!desktop && column.id === columns[0]?.id && row.id === "locked:0") return { text: upgradeText, content: <UpgradeLabel text={upgradeText} onPress={upgrade} role="attention-upgrade" /> };
          return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>Hidden</Text></Blurred> } : { text: "░░░░", color: colors.textDim };
        }
        const value = row.values[column.id];
        if (value == null || value === "") return missingCell(colors);
        if (column.id === "symbol" && typeof value === "string") return listingCell(value, colors, state.selected);
        // A first is news; a flagged spike is shown, ranked last.
        if (column.id === "kind" && typeof value === "string") {
          const tone = row.signal?.flags.length ? "muted" : "positive";
          return { text: value, color: toneColor(tone, colors), keepColorWhenSelected: tone !== "muted" };
        }
        if (column.id === "check" && typeof value === "string") return { text: value, value, color: toneColor("warning", colors), keepColorWhenSelected: true };
        if (typeof value === "number") {
          return { text: signalsNumber(column.id, value), value, color: SIGNALS_SIGNED_COLUMNS.has(column.id) ? signedColor(value, colors) : column.id === "mean" || column.id === "prior" ? colors.textDim : colors.text };
        }
        if ((column.id === "label" || column.id === "location") && row.values.country) return withCountryFlag({ text: value, value, color: column.id === "label" ? colors.textBright : colors.text }, String(row.values.country), desktop);
        return { text: value, value, color: column.id === "name" || column.id === "title" || column.id === "label" ? colors.textBright : column.id === "date" || column.id === "week" || column.id === "since" ? colors.textDim : colors.text };
      }} selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${scope}:${sectionId}:${filter}`}
      emptyStateTitle={section?.empty ?? ""} bodyAfter={lockedRows && desktop ? <LockedOverlay rows={lockedRows} text={upgradeText} onPress={upgrade} role="attention-upgrade" /> : undefined} />}
  />;
}
