import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import type { HiringBuildingFilter, HiringBuildingShift } from "../../../api-client/hiring";
import { ChartTableHeader, DataTableView, PageStackView, PaneFooterScope, PaneLinkMenu, QueryBar, usePagedRows, usePaneStatusFooter, useTableLoadMore, withCountryFlag, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { DetailReader, type DetailFact } from "../../../components/reader/detail-reader";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { useOpenDescription } from "../shared/open-description";
import { listingCell, missingCell, shareCell, signedColor, toneColor, withoutQuietColumns } from "../shared/research-cells";
import { BUILDING_FILTERS, BUILDING_SIGNED_COLUMNS, BUILDING_VIEWS, buildingBoardModel, buildingNumber, buildingSign, companyBuildingModel, isBuildingFilter, isBuildingView, shiftFacts, type BuildingRow } from "./building-model";
import { cachedBuilding, fetchBuilding, loadBuilding, validateBuilding, type BuildingPayload } from "./client";
import { sortAttentionRows } from "./model";

const rowId = (row: BuildingRow) => row.id;
const locked = (row: BuildingRow) => row.id.startsWith("locked:");
/** A company with no shift leaves the Note column out. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { note: [""], title: [""] };
/** Postings a shift's detail links to, so the sentence after them stays in view; the Postings view lists them all. */
const DETAIL_POSTINGS = 3;

export interface HiringBuildingViewProps {
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
 * HIRE's Building tab. Alone, the latest week's shifts: role families and
 * themes whose share of a company's new roles rose against its own weeks.
 * Enter opens the company, `e` says why. On a ticker, the company's whole
 * mix by role family and by theme, now and before, its shifts this week and
 * earlier, and the postings behind this week's.
 */
export function HiringBuildingView({ symbol, width, height, focused, accessKey, company }: HiringBuildingViewProps) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const openDescription = useOpenDescription();
  const upgrade = useCloudUpgradeAction("hire");
  const scope = `hiring:building:${symbol ?? "board"}`;
  const [openingFilter] = usePaneSettingValue<string>("buildingDimension", "all");
  const [storedFilter, setFilter] = usePluginPaneState<string>("hiring:building:filter", openingFilter);
  const filter: HiringBuildingFilter = isBuildingFilter(storedFilter) ? storedFilter : "all";
  const [openingView] = usePaneSettingValue<string>("buildingView", "families");
  const [storedView, setView] = usePluginPaneState<string>(`${scope}:view`, openingView);
  const view = isBuildingView(storedView) ? storedView : "families";
  const [snapshotSetting] = usePaneSettingValue<BuildingPayload | null>("buildingSnapshot", null);
  // A `gloomberb shot` hands the payload in; a company opened from a board snapshot still loads its own.
  const snapshot = useMemo(() => {
    try {
      const payload = snapshotSetting ? validateBuilding(snapshotSetting) : null;
      return payload && ("filter" in payload ? !symbol : payload.symbol.toUpperCase() === symbol?.toUpperCase()) ? payload : null;
    } catch { return null; }
  }, [snapshotSetting, symbol]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadBuilding(symbol, accessKey, filter, force), [snapshot, symbol, accessKey, filter]);
  const resource = useAsyncResource(loader, { initialData: () => cachedBuilding(symbol, accessKey, filter), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  const model = useMemo(() => !data ? null : "filter" in data ? buildingBoardModel(data, filter) : companyBuildingModel(data), [data, filter]);
  const sectionId = symbol ? view : "board";
  const section = model?.sections[sectionId];
  const pageLoader = useCallback(async ({ offset, signal }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const payload = offset === 0 && data ? data : await fetchBuilding(undefined, { filter, offset, limit: 100 }, undefined, signal);
    if (!("filter" in payload)) return { rows: [], hasMore: false, nextOffset: null };
    const next = !payload.preview && offset + payload.shifts.length < payload.total ? offset + payload.shifts.length : null;
    return { rows: buildingBoardModel(payload, filter).sections.board!.rows, hasMore: !snapshot && next !== null, nextOffset: next };
  }, [data, filter, snapshot]);
  const paged = usePagedRows(data && !symbol ? pageLoader : null, { getId: rowId });
  const sectionRows = !symbol && paged.status !== "idle" ? paged.rows : section?.rows ?? [];
  // The server's order (the clearest shifts first, the mix by its share now) until a header is clicked.
  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" } | null>(`${scope}:${sectionId}:sort`, null);
  const lockedRows = Math.min(3, section?.locked ?? 0);
  const upgradeText = symbol ? "Upgrade for the whole mix" : "Upgrade for all shifts";
  const rows = useMemo(() => [...(sort ? sortAttentionRows(sectionRows, sort.column, sort.direction) : sectionRows) as BuildingRow[],
    ...Array.from({ length: lockedRows }, (_, index): BuildingRow => ({ id: `locked:${index}`, values: {} }))], [sectionRows, sort, lockedRows]);
  const dataRows = useMemo(() => rows.filter((row) => !locked(row)), [rows]);
  const columns = useMemo(() => !section ? [] : withoutQuietColumns(section.columns, dataRows, (row, id) => row.values[id] ?? "", QUIET_COLUMNS), [section, dataRows]);
  const maxShare = Math.max(0, ...dataRows.map((row) => typeof row.values.share === "number" ? row.values.share : 0));
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
  // A shift opens its first posting; a posting row its own.
  const sourceRow = opened ?? selected;
  const source = sourceRow?.jobPosting?.url ?? sourceRow?.shift?.postings[0]?.url ?? null;
  const hints: PaneHint[] = [
    ...(source ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(source) }] : []),
    // On a company Enter already opens a shift or a posting.
    ...(!symbol && selected?.shift && !opened ? [{ id: "evidence", key: "e", label: "vidence", title: "Why it shifted", onPress: () => setOpenRow(selected.id) }] : []),
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
    ? [{ id: "view", label: "View", value: view, options: BUILDING_VIEWS.map((entry) => ({ ...entry })), onChange: (value: string) => { setView(value); setOpenRow(null); } }]
    : [{ id: "dimension", label: "Show", value: filter, defaultValue: "all", options: BUILDING_FILTERS.map((entry) => ({ ...entry })), onChange: (value: string) => { setFilter(value); setOpenRow(null); } }]} />;
  const shiftDetail = (shift: HiringBuildingShift): DetailFact[] => [
    ...shiftFacts(shift),
    // The postings behind it, each opening the employer's page.
    ...shift.postings.slice(0, DETAIL_POSTINGS).map((posting, index): DetailFact => ({ label: index === 0 ? "Postings" : "", value: `${posting.title.trim()}${posting.location ? `, ${posting.location}` : ""}`,
      ...(posting.url ? { link: { label: "Open posting", onOpen: () => void host.openExternal(posting.url!) } } : {}) })),
    ...(shift.postings.length > DETAIL_POSTINGS ? [{ label: "", value: `${shift.postings.length - DETAIL_POSTINGS} more in ${symbol ? "the" : "the company's"} Postings view` }] : []),
  ];
  const detailTitle = openCompany ?? (opened?.jobPosting ? opened.jobPosting.title.trim() : opened?.shift ? `${opened.shift.symbol} · ${opened.shift.label}` : undefined);
  const detail = openCompany && company ? <PaneFooterScope active>{company.render(openCompany, width, height - 1)}</PaneFooterScope>
    : opened ? <PaneLinkMenu><DetailReader resetScrollKey={opened.id} width={width}
      facts={opened.jobPosting ? opened.details ?? [] : opened.shift ? shiftDetail(opened.shift) : []} body={opened.jobPosting ? null : opened.shift?.why ?? null} note={opened.jobPosting?.url ?? null} /></PaneLinkMenu> : null;
  // A mix row opens its shift, when it has one this week.
  const shiftOf = (row: BuildingRow) => row.mix ? model?.sections.shifts?.rows.find((entry) => entry.shift && entry.shift.week === model.week && `${entry.shift.dimension}:${entry.shift.key}` === row.id) ?? null : null;
  return <PageStackView focused={focused} detailOpen={detailOpen} onBack={() => { company?.onOpen(null); setOpenRow(null); }} detailTitle={detailTitle} detailContent={detail}
    rootContent={<DataTableView columns={columns} items={model && section ? rows : []} rootWidth={width} rootHeight={height} focused={focused && !detailOpen} scrollRef={scrollRef} onBodyScrollActivity={scrollMore}
      status={!data ? { loading: resource.loading, error: resource.error, subject: "what companies are building" } : undefined}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns} query={query} figures={model?.figures} />}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelected }} getItemKey={rowId}
      sortColumnId={sort?.column ?? null} sortDirection={sort?.direction ?? "desc"} onHeaderClick={(column) => setSort((old) => ({ column, direction: old?.column === column && old.direction === "desc" ? "asc" : "desc" }))}
      onActivate={(row) => {
        if (locked(row)) return void upgrade();
        if (!symbol && row.symbol && company) return company.onOpen(row.symbol);
        const target = row.shift || row.jobPosting ? row : shiftOf(row);
        if (!target) return;
        // A mix row's shift opens from the Shifts view, where its detail lives.
        if (row.mix) setView("shifts");
        setOpenRow(target.id);
      }}
      renderCell={(row, column, _index, state) => {
        if (locked(row)) {
          if (!desktop && column.id === columns[0]?.id && row.id === "locked:0") return { text: upgradeText, content: <UpgradeLabel text={upgradeText} onPress={upgrade} role="attention-upgrade" /> };
          return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>Hidden</Text></Blurred> } : { text: "░░░░", color: colors.textDim };
        }
        const value = row.values[column.id];
        // A family or theme with no shift has nothing to note.
        if (column.id === "note" && value == null) return { text: "" };
        if (value == null || value === "") return missingCell(colors);
        if (column.id === "symbol" && typeof value === "string") return listingCell(value, colors, state.selected);
        // Every shift is news, as a first or a spike is on the other tabs.
        if (column.id === "kind" && typeof value === "string") return { text: value, color: toneColor("positive", colors), keepColorWhenSelected: true };
        if (column.id === "note" && typeof value === "string") return { text: value, value, color: toneColor(value === "Shift" ? "positive" : "muted", colors), keepColorWhenSelected: value === "Shift" };
        if (typeof value === "number") {
          const text = buildingNumber(column.id, value);
          if (column.id === "share") return { ...shareCell(text, maxShare ? value / maxShare : null, column.width, colors, state.selected), value };
          return { text, value, color: BUILDING_SIGNED_COLUMNS.has(column.id) ? signedColor(buildingSign(column.id, value), colors) : column.id === "before" || column.id === "beforeRoles" ? colors.textDim : colors.text };
        }
        if (column.id === "location" && row.values.country) return withCountryFlag({ text: value, value, color: colors.text }, String(row.values.country), desktop);
        return { text: value, value, color: column.id === "name" || column.id === "title" || column.id === "label" ? colors.textBright : column.id === "date" || column.id === "week" || column.id === "weeks" ? colors.textDim : colors.text };
      }} selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${scope}:${sectionId}:${filter}`}
      emptyStateTitle={section?.empty ?? ""} bodyAfter={lockedRows && desktop ? <LockedOverlay rows={lockedRows} text={upgradeText} onPress={upgrade} role="attention-upgrade" /> : undefined} />}
  />;
}
