import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import type { HiringMovePosting } from "../../../api-client/hiring";
import { ChartTableHeader, DataTableView, PageStackView, PaneFooterScope, PaneLinkMenu, QueryBar, usePagedRows, usePaneStatusFooter, useTableLoadMore, withCountryFlag, type DataTableCell, type DataTableColumn, type PaneHint, type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { DetailReader, type DetailFact } from "../../../components/reader/detail-reader";
import { dayCell } from "../../../components/ui/day-cell";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { logFailure } from "../../../utils/log-failure";
import type { CloudResource } from "../shared/cloud-resource";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { lockedTableCell, lockedTableOverlay } from "../shared/locked-rows";
import { useTickerJumpHints } from "../shared/open-description";
import { listingCell, missingCell, withoutQuietColumns } from "../shared/research-cells";
import { sortAttentionRows, type AttentionRow } from "./model";

interface HiringCompanyNav { open: string | null; onOpen: (symbol: string | null) => void; render: (symbol: string, width: number, height: number) => ReactNode }
export interface HiringTabProps { symbol?: string; width: number; height: number; focused: boolean; accessKey: string; company?: HiringCompanyNav }
type FeedSection<TRow extends AttentionRow> = { columns: DataTableColumn[]; rows: TRow[]; empty: string; locked: number };
type FeedModel<TRow extends AttentionRow> = { asOf: string | null; preview: boolean; figures: StatItem[]; sections: Partial<Record<string, FeedSection<TRow>>> };
type Option<T extends string> = { readonly value: T; readonly label: string };
type RenderCtx<TRow extends AttentionRow> = { colors: ReturnType<typeof useThemeColors>; desktop: boolean; dataRows: readonly TRow[] };

/** Postings a signal or shift detail links to, so the sentence after them stays in view; the Postings view lists them all. */
const DETAIL_POSTINGS = 3;
export function postingDetailFacts(postings: readonly HiringMovePosting[], symbol: string | undefined, openUrl: (url: string) => void): DetailFact[] {
  return [
    ...postings.slice(0, DETAIL_POSTINGS).map((posting, index): DetailFact => ({
      label: index === 0 ? "Postings" : "",
      value: `${posting.title.trim()}${posting.location ? `, ${posting.location}` : ""}`,
      ...(posting.url ? { link: { label: "Open posting", onOpen: () => openUrl(posting.url!) } } : {}),
    })),
    ...(postings.length > DETAIL_POSTINGS ? [{ label: "", value: `${postings.length - DETAIL_POSTINGS} more in ${symbol ? "the" : "the company's"} Postings view` }] : []),
  ];
}

const locked = (row: AttentionRow) => row.id.startsWith("locked:");
const rowId = (row: AttentionRow) => row.id;
const BRIGHT_COLUMNS = new Set(["name", "title", "label"]);
const DIM_COLUMNS = new Set(["date", "week", "weeks", "excluded", "since"]);

export function HiringFeedView<TPayload, TFilter extends string, TView extends string, TRow extends AttentionRow, TModel extends FeedModel<TRow> = FeedModel<TRow>>(
  props: HiringTabProps & {
    scope: string;
    filter: { setting: string; stateKey: string; queryId: string; fallback: TFilter; is: (v: string) => v is TFilter; options: readonly Option<TFilter>[] };
    view: { setting: string; fallback: TView; is: (v: string) => v is TView; options: readonly Option<TView>[] };
    snapshot: { setting: string; logScope: string; logLabel: string; validate: (raw: TPayload) => TPayload; matches: (payload: TPayload) => boolean };
    load: (filter: TFilter, force: boolean) => Promise<CloudResource<TPayload>>;
    cached: (filter: TFilter) => CloudResource<TPayload> | null;
    fetchPage: (filter: TFilter, offset: number, signal: AbortSignal) => Promise<TPayload>;
    pageInfo: (payload: TPayload) => { count: number; total: number; preview: boolean } | null;
    toModel: (payload: TPayload, filter: TFilter) => TModel;
    quietColumns: Record<string, readonly string[]>;
    subjectLabel: string;
    upgradeText: string;
    canOpenRow?: (row: TRow) => boolean;
    onActivateRow?: (row: TRow, helpers: { model: TModel | null; setView: (v: string) => void; setOpenRow: (id: string | null) => void }) => void;
    sourceUrl: (opened: TRow | null, selected: TRow | null) => string | null | undefined;
    evidenceTitle: (selected: TRow) => string | null;
    extraCompanyHints?: (subject: string, desktop: boolean) => PaneHint[];
    detailOf: (opened: TRow, openUrl: (url: string) => void) => { title: string | undefined; facts: DetailFact[]; body: string | null; note: string | null };
    renderEmptyCell?: (row: TRow, column: DataTableColumn) => DataTableCell | undefined;
    renderValueCell: (row: TRow, column: DataTableColumn, value: string | number, selected: boolean, ctx: RenderCtx<TRow>) => DataTableCell | undefined;
  },
) {
  const { scope, symbol, width, height, focused, accessKey, company, filter: fc, view: vc, snapshot: sc, load, cached, fetchPage, pageInfo, toModel, quietColumns, subjectLabel, upgradeText, canOpenRow, onActivateRow, sourceUrl, evidenceTitle, extraCompanyHints, detailOf, renderEmptyCell, renderValueCell } = props;
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const rawUpgrade = useCloudUpgradeAction("hire");
  const upgrade = useCallback(() => { void rawUpgrade().catch(logFailure(sc.logScope, "Open Pro upgrade failed")); }, [sc.logScope, rawUpgrade]);
  const openUrl = useCallback((url: string) => { void host.openExternal(url).catch(logFailure(sc.logScope, "Open external link failed")); }, [host, sc.logScope]);

  const [openingFilter] = usePaneSettingValue<string>(fc.setting, fc.fallback);
  const [storedFilter, setFilter] = usePluginPaneState<string>(fc.stateKey, openingFilter);
  const filter: TFilter = fc.is(storedFilter) ? storedFilter : fc.fallback;
  const [openingView] = usePaneSettingValue<string>(vc.setting, vc.fallback);
  const [storedView, setView] = usePluginPaneState<string>(`${scope}:view`, openingView);
  const view: TView = vc.is(storedView) ? storedView : vc.fallback;
  const [snapshotSetting] = usePaneSettingValue<TPayload | null>(sc.setting, null);
  // A `gloom shot` hands the payload in; a company opened from a board snapshot still loads its own.
  const snapshot = useMemo(() => {
    try {
      const payload = snapshotSetting ? sc.validate(snapshotSetting) : null;
      return payload && sc.matches(payload) ? payload : null;
    } catch (error) {
      logFailure(sc.logScope, sc.logLabel)(error);
      return null;
    }
  }, [snapshotSetting, sc.validate, sc.matches, sc.logScope, sc.logLabel]);

  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : load(filter, force), [snapshot, load, filter]);
  const resource = useAsyncResource(loader, { initialData: () => cached(filter), clearOnError: isAccessDenied, keepPreviousData: accessKey });
  const data = resource.data?.payload;
  const model = useMemo(() => data ? toModel(data, filter) : null, [data, filter, toModel]);
  const sectionId = symbol ? view : "board";
  const section = model?.sections[sectionId];
  const pageLoader = useCallback(async ({ offset, signal }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const payload = offset === 0 && data ? data : await fetchPage(filter, offset, signal);
    const page = pageInfo(payload);
    if (!page) return { rows: [], hasMore: false, nextOffset: null };
    const next = !page.preview && offset + page.count < page.total ? offset + page.count : null;
    return { rows: toModel(payload, filter).sections.board!.rows, hasMore: !snapshot && next !== null, nextOffset: next };
  }, [data, filter, snapshot, fetchPage, pageInfo, toModel]);
  const paged = usePagedRows(data && !symbol ? pageLoader : null, { getId: rowId });
  const sectionRows = !symbol && paged.status !== "idle" ? paged.rows : section?.rows ?? [];

  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" } | null>(`${scope}:${sectionId}:sort`, null);
  const lockedRows = Math.min(3, section?.locked ?? 0);
  const rows = useMemo(() => [
    ...(sort ? sortAttentionRows(sectionRows, sort.column, sort.direction) : sectionRows) as TRow[],
    ...Array.from({ length: lockedRows }, (_, index) => ({ id: `locked:${index}`, values: {} }) as TRow),
  ], [sectionRows, sort, lockedRows]);
  const dataRows = useMemo(() => rows.filter((row) => !locked(row)), [rows]);
  const columns = useMemo(() => !section ? [] : withoutQuietColumns(section.columns, dataRows, (row, id) => row.values[id] ?? "", quietColumns), [section, dataRows, quietColumns]);
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`${scope}:${sectionId}:selected`, null);
  const openCompany = company?.open ?? null;
  const [openRowId, setOpenRow] = usePluginPaneState<string | null>(`${scope}:open`, null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const opened = dataRows.find((row) => row.id === openRowId && (!canOpenRow || canOpenRow(row))) ?? null;
  const detailOpen = !!openCompany || !!opened;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollMore = useTableLoadMore(scrollRef, paged.hasMore && !detailOpen, paged.loadMore);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { resource.reload(); paged.reload(); }, { focused: focused && !detailOpen });

  const jumpHints = useTickerJumpHints();
  const subject = selected?.symbol ?? symbol;
  const source = sourceUrl(opened, selected);
  const evidence = !symbol && selected && !opened ? evidenceTitle(selected) : null;
  const hints: PaneHint[] = [
    ...(source ? [{ id: "source", key: "o", label: "pen source", onPress: () => openUrl(source) }] : []),
    ...(evidence && selected ? [{ id: "evidence", key: "e", label: "vidence", title: evidence, onPress: () => setOpenRow(selected.id) }] : []),
    ...(subject && !opened ? [
      ...jumpHints(subject),
      { id: "related", key: "a", label: "pps", title: "App attention", onPress: () => createPaneFromTemplate("apps-pane", { symbol: subject }) },
      ...(extraCompanyHints ? extraCompanyHints(subject, desktop) : []),
    ] : []),
    ...(model?.preview ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({
    registrationId: `${scope}:status`, enabled: !openCompany, loading: resource.loading || paged.loadingMore,
    error: data ? resource.error ?? paged.moreError?.message ?? paged.error?.message : null, stale: resource.data?.stale,
    info: [
      ...(model?.asOf ? [{ id: "observed", asOf: true, parts: [{ text: `as of ${model.asOf.slice(0, 10)}`, tone: "muted" as const }] }] : []),
      ...(model?.preview ? [{ id: "preview", parts: [{ text: "Pro preview", tone: "warning" as const }] }] : []),
    ],
    hints,
  });

  const query = <QueryBar width={width} filters={symbol
    ? [{ id: "view", label: "View", value: view, options: vc.options.map((entry) => ({ ...entry })), onChange: (v: string) => { setView(v); setOpenRow(null); } }]
    : [{ id: fc.queryId, label: "Show", value: filter, defaultValue: fc.fallback, options: fc.options.map((entry) => ({ ...entry })), onChange: (v: string) => { setFilter(v); setOpenRow(null); } }]} />;
  const openedDetail = opened ? detailOf(opened, openUrl) : null;
  const detail = openCompany && company
    ? <PaneFooterScope active>{company.render(openCompany, width, height - 1)}</PaneFooterScope>
    : opened && openedDetail
      ? <PaneLinkMenu><DetailReader resetScrollKey={opened.id} width={width} facts={openedDetail.facts} body={openedDetail.body} note={openedDetail.note} /></PaneLinkMenu>
      : null;
  const renderCtx: RenderCtx<TRow> = { colors, desktop, dataRows };
  return <PageStackView focused={focused} detailOpen={detailOpen} onBack={() => { company?.onOpen(null); setOpenRow(null); }} detailTitle={openCompany ?? openedDetail?.title} detailContent={detail}
    rootContent={<DataTableView columns={columns} items={model && section ? rows : []} rootWidth={width} rootHeight={height} focused={focused && !detailOpen} scrollRef={scrollRef} onBodyScrollActivity={scrollMore}
      status={!data ? { loading: resource.loading, error: resource.error, subject: subjectLabel } : undefined}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns} query={query} figures={model?.figures} />}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelected }} getItemKey={rowId}
      sortColumnId={sort?.column ?? null} sortDirection={sort?.direction ?? "desc"} onHeaderClick={(column) => setSort((old) => ({ column, direction: old?.column === column && old.direction === "desc" ? "asc" : "desc" }))}
      onActivate={(row) => {
        if (locked(row)) return upgrade();
        if (!symbol && row.symbol && company) return company.onOpen(row.symbol);
        if (onActivateRow) return onActivateRow(row, { model, setView, setOpenRow });
        if (!canOpenRow || canOpenRow(row)) setOpenRow(row.id);
      }}
      renderCell={(row, column, _index, state) => {
        if (locked(row)) {
          return lockedTableCell({
            desktop,
            isLabelCell: column.id === columns[0]?.id && row.id === "locked:0",
            upgradeText,
            onUpgrade: upgrade,
            role: "attention-upgrade",
            dimColor: colors.textDim,
          });
        }
        const value = row.values[column.id];
        if (value == null || value === "") return renderEmptyCell?.(row, column) ?? missingCell(colors);
        if (column.id === "symbol" && typeof value === "string") return listingCell(value, colors, state.selected);
        const custom = renderValueCell(row, column, value, state.selected, renderCtx);
        if (custom) return custom;
        if (column.id === "location" && row.values.country) return withCountryFlag({ text: String(value), value, color: colors.text }, String(row.values.country), desktop);
        if ((column.id === "date" || column.id === "week") && typeof value === "string") return { ...dayCell(value), color: colors.textDim };
        return { text: String(value), value, color: BRIGHT_COLUMNS.has(column.id) ? colors.textBright : DIM_COLUMNS.has(column.id) ? colors.textDim : colors.text };
      }} selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${scope}:${sectionId}:${filter}`}
      emptyStateTitle={section?.empty ?? ""} bodyAfter={lockedTableOverlay(lockedRows, desktop, upgradeText, upgrade, "attention-upgrade")} />}
  />;
}
