import { useCallback, useMemo, useRef, type ReactNode } from "react";
import { isAccessDenied } from "../../../api-client/errors";
import type { HiringMovesFilter } from "../../../api-client/hiring";
import { ChartTableHeader, DataTableView, PageStackView, PaneFooterScope, PaneLinkMenu, QueryBar, usePagedRows, usePaneStatusFooter, useTableLoadMore, withCountryFlag, type PaneHint } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { openFormModal } from "../../../components/form-modal/request";
import { DetailReader } from "../../../components/reader/detail-reader";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginAppActions, usePluginPaneState } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Text, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { getSharedRegistry } from "../../registry/shared";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { Blurred, LockedOverlay, UpgradeLabel } from "../shared/locked-rows";
import { useOpenDescription } from "../shared/open-description";
import { listingCell, missingCell, signedColor, toneColor, withoutQuietColumns } from "../shared/research-cells";
import { cachedMoves, fetchMoves, loadMoves, validateMoves, type MovesPayload } from "./client";
import { sortAttentionRows } from "./model";
import { companyMovesModel, isMovesFilter, isMovesView, moveFacts, movesBoardModel, movesNumber, MOVES_FILTERS, MOVES_SIGNED_COLUMNS, MOVES_VIEWS, SIGNAL_TONE, type MovesRow } from "./moves-model";

const rowId = (row: MovesRow) => row.id;
const locked = (row: MovesRow) => row.id.startsWith("locked:");
/** Every row of the board reads the same week; a company's weeks before any move have no pace yet. */
const QUIET_COLUMNS: Record<string, readonly string[]> = { pace: [""], z: [""], signal: [""], excluded: [""], driver: [""] };

export interface HiringMovesViewProps {
  symbol?: string;
  width: number;
  height: number;
  focused: boolean;
  /** Plan and session, so a cached read is never shown to the wrong account. */
  accessKey: string;
  /**
   * The board opens a company as HIRE's table does, on its Moves tab: HIRE
   * holds which one, so its tab strip makes way for the company's.
   */
  company?: { open: string | null; onOpen: (symbol: string | null) => void; render: (symbol: string, width: number, height: number) => ReactNode };
}

/**
 * HIRE's Moves tab. Alone it lists the companies whose new roles moved
 * against their own weeks in the latest week; Enter opens one, `e` says why.
 * On a ticker it shows the company's weeks (and why a week is not measured),
 * the role families and titles behind its move and the postings first seen
 * and closed that week.
 */
export function HiringMovesView({ symbol, width, height, focused, accessKey, company }: HiringMovesViewProps) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  const host = useRendererHost();
  const { createPaneFromTemplate } = usePluginAppActions();
  const openDescription = useOpenDescription();
  const upgrade = useCloudUpgradeAction("hire");
  const scope = `hiring:moves:${symbol ?? "board"}`;
  const [openingFilter] = usePaneSettingValue<string>("movesFilter", "moves");
  const [storedFilter, setFilter] = usePluginPaneState<string>("hiring:moves:filter", openingFilter);
  const filter: HiringMovesFilter = isMovesFilter(storedFilter) ? storedFilter : "moves";
  const [openingView] = usePaneSettingValue<string>("movesView", "weeks");
  const [storedView, setView] = usePluginPaneState<string>(`${scope}:view`, openingView);
  const view = isMovesView(storedView) ? storedView : "weeks";
  const [snapshotSetting] = usePaneSettingValue<MovesPayload | null>("movesSnapshot", null);
  // A `gloomberb shot` hands the payload in; a company opened from a board snapshot still loads its own.
  const snapshot = useMemo(() => {
    try {
      const payload = snapshotSetting ? validateMoves(snapshotSetting) : null;
      return payload && ("moves" in payload ? !symbol : payload.symbol.toUpperCase() === symbol?.toUpperCase()) ? payload : null;
    } catch { return null; }
  }, [snapshotSetting, symbol]);
  const loader = useCallback((force: boolean) => snapshot ? Promise.resolve({ payload: snapshot, stale: false, refreshError: null }) : loadMoves(symbol, accessKey, filter, force), [snapshot, symbol, accessKey, filter]);
  const resource = useAsyncResource(loader, { initialData: () => cachedMoves(symbol, accessKey, filter), clearOnError: isAccessDenied, keepPreviousData: true });
  const data = resource.data?.payload;
  const model = useMemo(() => !data ? null : "moves" in data ? movesBoardModel(data, filter) : companyMovesModel(data), [data, filter]);
  const sectionId = symbol ? view : "board";
  const section = model?.sections[sectionId];
  const pageLoader = useCallback(async ({ offset, signal }: { offset: number; signal: AbortSignal; force: boolean }) => {
    const payload = offset === 0 && data ? data : await fetchMoves(undefined, { filter, offset, limit: 100 }, undefined, signal);
    if (!("moves" in payload)) return { rows: [], hasMore: false, nextOffset: null };
    const next = !payload.preview && offset + payload.moves.length < payload.total ? offset + payload.moves.length : null;
    return { rows: movesBoardModel(payload, filter).sections.board!.rows, hasMore: !snapshot && next !== null, nextOffset: next };
  }, [data, filter, snapshot]);
  const paged = usePagedRows(data && !symbol ? pageLoader : null, { getId: rowId });
  const sectionRows = !symbol && paged.status !== "idle" ? paged.rows : section?.rows ?? [];
  // The board keeps the server's order (the strongest moves first) until a header is clicked.
  const [sort, setSort] = usePluginPaneState<{ column: string; direction: "asc" | "desc" } | null>(`${scope}:${sectionId}:sort`, null);
  const lockedRows = Math.min(3, section?.locked ?? 0);
  const upgradeText = symbol ? "Upgrade for all observations" : "Upgrade for all moves";
  const rows = useMemo(() => [...(sort ? sortAttentionRows(sectionRows, sort.column, sort.direction) : sectionRows) as MovesRow[],
    ...Array.from({ length: lockedRows }, (_, index): MovesRow => ({ id: `locked:${index}`, values: {} }))], [sectionRows, sort, lockedRows]);
  const dataRows = useMemo(() => rows.filter((row) => !locked(row)), [rows]);
  const columns = useMemo(() => !section ? [] : withoutQuietColumns(section.columns, dataRows, (row, id) => row.values[id] ?? "", QUIET_COLUMNS), [section, dataRows]);
  const [selectedId, setSelected] = usePluginPaneState<string | null>(`${scope}:${sectionId}:selected`, null);
  const openCompany = company?.open ?? null;
  const [openRowId, setOpenRow] = usePluginPaneState<string | null>(`${scope}:open`, null);
  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const opened = dataRows.find((row) => row.id === openRowId && (row.move || row.posting)) ?? null;
  const detailOpen = !!openCompany || !!opened;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const scrollMore = useTableLoadMore(scrollRef, paged.hasMore && !detailOpen, paged.loadMore);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => { void resource.reload(); paged.reload(); }, { focused: focused && !detailOpen });

  const subject = selected?.symbol ?? symbol;
  const source = opened?.posting?.url ?? (opened ? null : selected?.posting?.url);
  // ALRT's hiring move alert on the company, as ERN's `n` opens an earnings one.
  const alerts = desktop && getSharedRegistry()?.commands.has("set-event-alert") === true;
  const hints: PaneHint[] = [
    ...(source ? [{ id: "source", key: "o", label: "pen source", onPress: () => void host.openExternal(source) }] : []),
    // On a company Enter already opens a week's move or a posting.
    ...(!symbol && selected?.move && !opened ? [{ id: "evidence", key: "e", label: "vidence", title: "Why it moved", onPress: () => setOpenRow(selected.id) }] : []),
    ...(subject && !opened ? [
      { id: "description", key: "d", label: "es", onPress: () => openDescription(subject) },
      { id: "financials", key: "f", label: "a", onPress: () => createPaneFromTemplate("financial-analysis-pane", { symbol: subject }) },
      { id: "chart", key: "g", label: "raph", onPress: () => createPaneFromTemplate("chart-composer-pane", { arg: subject }) },
      { id: "related", key: "a", label: "pps", title: "App attention", onPress: () => createPaneFromTemplate("apps-pane", { symbol: subject }) },
      ...(alerts ? [{ id: "alert", key: "n", label: "otify", title: "Hiring move alert", onPress: () => {
        openFormModal({ kind: "plugin-command", commandId: "set-event-alert", values: { event: "hiring_move", "hiring_move:symbol": subject } });
      } }] : []),
    ] : []),
    ...(model?.preview ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: upgrade }] : []),
  ];
  usePaneStatusFooter({ registrationId: `${scope}:status`, enabled: !openCompany, loading: resource.loading || paged.loadingMore, error: data ? resource.error ?? paged.moreError?.message ?? paged.error?.message : null, stale: resource.data?.stale,
    info: [...(model?.asOf ? [{ id: "observed", asOf: true, parts: [{ text: `as of ${model.asOf.slice(0, 10)}`, tone: "muted" as const }] }] : []), ...(model?.preview ? [{ id: "preview", parts: [{ text: "Pro preview", tone: "warning" as const }] }] : [])], hints });

  const query = <QueryBar width={width} filters={symbol
    ? [{ id: "view", label: "View", value: view, options: MOVES_VIEWS.map((entry) => ({ ...entry })), onChange: (value: string) => { setView(value); setOpenRow(null); } }]
    : [{ id: "signal", label: "Show", value: filter, defaultValue: "moves", options: MOVES_FILTERS.map((entry) => ({ ...entry })), onChange: (value: string) => { setFilter(value); setOpenRow(null); } }]} />;
  const detailTitle = openCompany ?? (opened?.move ? `${opened.move.symbol} · week of ${opened.move.week}` : opened?.posting?.title.trim());
  const detail = openCompany && company ? <PaneFooterScope active>{company.render(openCompany, width, height - 1)}</PaneFooterScope>
    : opened ? <PaneLinkMenu><DetailReader resetScrollKey={opened.id} width={width}
      facts={opened.move ? moveFacts(opened.move) : opened.details ?? []} body={opened.move?.why ?? null} note={opened.posting?.url ?? null} /></PaneLinkMenu> : null;
  return <PageStackView focused={focused} detailOpen={detailOpen} onBack={() => { company?.onOpen(null); setOpenRow(null); }} detailTitle={detailTitle} detailContent={detail}
    rootContent={<DataTableView columns={columns} items={model && section ? rows : []} rootWidth={width} rootHeight={height} focused={focused && !detailOpen} scrollRef={scrollRef} onBodyScrollActivity={scrollMore}
      status={!data ? { loading: resource.loading, error: resource.error, subject: "hiring moves" } : undefined}
      rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns} query={query} figures={model?.figures} />}
      selection={{ kind: "id", selectedId: selected?.id ?? null, getId: rowId, onChange: setSelected }} getItemKey={rowId}
      sortColumnId={sort?.column ?? null} sortDirection={sort?.direction ?? "desc"} onHeaderClick={(column) => setSort((old) => ({ column, direction: old?.column === column && old.direction === "desc" ? "asc" : "desc" }))}
      onActivate={(row) => locked(row) ? void upgrade() : !symbol && row.symbol && company ? company.onOpen(row.symbol) : row.move || row.posting ? setOpenRow(row.id) : undefined}
      renderCell={(row, column, _index, state) => {
        if (locked(row)) {
          if (!desktop && column.id === columns[0]?.id && row.id === "locked:0") return { text: upgradeText, content: <UpgradeLabel text={upgradeText} onPress={upgrade} role="attention-upgrade" /> };
          return desktop ? { text: "", content: <Blurred><Text fg={colors.textDim}>Hidden</Text></Blurred> } : { text: "░░░░", color: colors.textDim };
        }
        const value = row.values[column.id];
        if (value == null || value === "") return missingCell(colors);
        if (column.id === "symbol" && typeof value === "string") return listingCell(value, colors, state.selected);
        if (column.id === "signal" && typeof value === "string") {
          const tone = SIGNAL_TONE[value] ?? "muted";
          return { text: value, color: toneColor(tone, colors), keepColorWhenSelected: tone !== "muted" };
        }
        // A flagged move is shown, not alerted.
        if (column.id === "check" && typeof value === "string") return { text: value, value, color: toneColor("warning", colors), keepColorWhenSelected: true };
        if (typeof value === "number") {
          return { text: movesNumber(column.id, value), value, color: MOVES_SIGNED_COLUMNS.has(column.id) ? signedColor(value, colors) : column.id === "mean" ? colors.textDim : colors.text };
        }
        if (column.id === "location") return withCountryFlag({ text: value, value, color: colors.text }, String(row.values.country ?? ""), desktop);
        return { text: value, value, color: column.id === "name" || column.id === "title" ? colors.textBright : column.id === "date" || column.id === "week" || column.id === "excluded" ? colors.textDim : colors.text };
      }} selectedTextOverridesCellColor showHorizontalScrollbar resetScrollKey={`${scope}:${sectionId}:${filter}`}
      emptyStateTitle={section?.empty ?? ""} bodyAfter={lockedRows && desktop ? <LockedOverlay rows={lockedRows} text={upgradeText} onPress={upgrade} role="attention-upgrade" /> : undefined} />}
  />;
}
