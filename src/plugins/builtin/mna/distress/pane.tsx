import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import {
  DataTableStackView,
  DetailScrollBody,
  PaneStatusBody,
  QueryBar,
  SegmentedControl,
  unavailableText,
  usePagedRows,
  usePaneStatusLinkFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment,
  type PaneHint,
  type QueryBarFilter,
  type QueryBarSearch,
  type QueryBarView,
} from "../../../../components";
import { usePaneRefreshKey } from "../../../../components/data-table/table-pane";
import type {
  DistressAttribution,
  DistressDesignation,
  DistressFilingKind,
  GoingConcernDisclosure,
  InsolvencyNotice,
} from "../../../../api-client/distress";
import type { CloudFilingEventPayload } from "../../../../api-client";
import { useAutoRefresh, usePluginPaneState } from "../../../../public/react";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, type ScrollBoxRenderable } from "../../../../ui";
import { usePluginTickerActions } from "../../../runtime";
import {
  canPage,
  loadDesignations,
  loadDistressFilings,
  loadGoingConcern,
  loadInsolvencyNotices,
  PAGE_LIMIT,
  type LoadedPage,
} from "./client";
import { DesignationDetail, FilingDetail, GoingConcernDetail, InsolvencyDetail } from "./detail";
import {
  ALL,
  cellText,
  COUNTRY_OPTIONS,
  DEFAULT_DISTRESS_VIEW,
  DESIGNATION_KIND_OPTIONS,
  designationColumns,
  designationDate,
  designationKindLabel,
  designationName,
  designationTicker,
  DATE_BASIS_LABELS,
  DISTRESS_VIEWS,
  distressView,
  exchangeLabel,
  EXCHANGE_OPTIONS,
  FILING_KIND_OPTIONS,
  filingColumns,
  filingDate,
  filingEventLabel,
  filingTicker,
  goingConcernColumns,
  goingConcernTitle,
  INSOLVENCY_KIND_OPTIONS,
  insolvencyColumns,
  insolvencyId,
  insolvencyNoticeLabel,
  insolvencyProcedureCell,
  isoDay,
  MISSING,
  namePrefix,
  VERDICT_LABELS,
  VERDICT_OPTIONS,
  venueTicker,
  type DistressViewId,
  type GoingConcernVerdictFilter,
  type ListingTicker,
  unlessAll,
} from "./model";

/** One page of any of the four lists, with the cache state of its first page. */
interface DistressPage<Row> {
  rows: Row[];
  hasMore: boolean;
  nextOffset: number;
  loaded: LoadedPage<unknown>;
  /** Licence terms of the sources on this page; the SEC lists have none. */
  attributions: DistressAttribution[];
}

type Loader<Row> = (request: { offset: number; signal: AbortSignal; force: boolean }) => Promise<DistressPage<Row>>;

/** What a list needs to know about its rows. */
interface RowSpec<Row> {
  getId: (row: Row) => string;
  title: (row: Row) => string;
  url: (row: Row) => string;
  ticker: (row: Row) => ListingTicker | null;
  cell: (row: Row, columnId: string, muted: string, base: string) => DataTableCell;
  detail: (row: Row, width: number, attributions: DistressAttribution[]) => ReactNode;
  /** Changing status the source date carries, e.g. the month the SEC data set covers. */
  footerInfo?: (rows: Row[]) => PaneFooterSegment[];
}

/**
 * Public records about companies in difficulty, one list per source: 8-K
 * filings, going-concern disclosures, exchange listing designations and
 * insolvency notices. Every view is free and needs no account.
 */
export function DistressBoard({ focused, width, height, tabStrip = null }: {
  focused: boolean;
  width: number;
  height: number;
  /**
   * The pane's own tab strip when the body draws it (the terminal). The source
   * picker then shares its row, so the query bar keeps its width for filters;
   * on the desktop the strip is in the title bar and the picker is the bar's view.
   */
  tabStrip?: ReactNode;
}) {
  const [storedView, setView] = usePluginPaneState<string>("distress:view", DEFAULT_DISTRESS_VIEW);
  const view = distressView(storedView);
  const [filingKind, setFilingKind] = usePluginPaneState<DistressFilingKind>("distress:filings:kind", "distress");
  const [verdict, setVerdict] = usePluginPaneState<GoingConcernVerdictFilter>("distress:going-concern:verdict", "doubt_raised");
  const [designationKind, setDesignationKind] = usePluginPaneState<string>("distress:listings:kind", ALL);
  const [exchange, setExchange] = usePluginPaneState<string>("distress:listings:exchange", ALL);
  const [country, setCountry] = usePluginPaneState<string>("distress:insolvency:country", ALL);
  const [insolvencyKind, setInsolvencyKind] = usePluginPaneState<string>("distress:insolvency:kind", ALL);
  const [query, setQuery] = usePluginPaneState<string>("distress:insolvency:query", "");
  const { active: searching, blur: blurSearch, focus: focusSearch, searchProps } = useQueryBarSearch();
  const prefix = namePrefix(query);
  // The open record of the current source, as its list keeps it.
  const [openRecord] = usePluginPaneState<string>(`distress:${view}:open`, "");

  const viewControl = useMemo<QueryBarView<DistressViewId>>(() => ({
    value: view,
    options: DISTRESS_VIEWS,
    onChange: (next) => {
      blurSearch();
      setView(next);
    },
    // The arrows pick the source; h and l stay with the pane's tabs. A record
    // being read keeps the arrows.
    focused: focused && !searching && !openRecord,
  }), [blurSearch, focused, openRecord, searching, setView, view]);

  const header = tabStrip ? (
    <Box height={1} flexShrink={0} flexDirection="row" paddingX={1} width={width} overflow="hidden">
      <Box flexGrow={1} flexShrink={1} minWidth={0} height={1} overflow="hidden" flexDirection="column">{tabStrip}</Box>
      <Box flexShrink={0} height={1}>
        <SegmentedControl
          options={DISTRESS_VIEWS}
          value={view}
          onChange={(next) => viewControl.onChange(next as DistressViewId)}
          focused={viewControl.focused}
        />
      </Box>
    </Box>
  ) : null;
  const common = {
    focused: focused && !searching,
    width,
    height: Math.max(1, height - (header ? 1 : 0)),
    viewControl: header ? null : viewControl,
  };

  let list: ReactNode;
  switch (view) {
    case "filings":
      list = (
        <FilingsList
          key="filings"
          {...common}
          kind={distressFilingKind(filingKind)}
          filters={[{ id: "items", label: "Items", value: distressFilingKind(filingKind), defaultValue: "distress", options: FILING_KIND_OPTIONS, onChange: setFilingKind }]}
        />
      );
      break;
    case "going-concern":
      list = (
        <GoingConcernList
          key="going-concern"
          {...common}
          verdict={verdictFilter(verdict)}
          filters={[{ id: "verdict", label: "Disclosure", value: verdictFilter(verdict), defaultValue: "doubt_raised", options: VERDICT_OPTIONS, onChange: setVerdict }]}
        />
      );
      break;
    case "listings":
      list = (
        <DesignationsList
          key="listings"
          {...common}
          kind={designationKind}
          exchange={exchange}
          filters={[
            { id: "status", label: "Status", value: designationKind, defaultValue: ALL, options: DESIGNATION_KIND_OPTIONS, onChange: setDesignationKind },
            { id: "exchange", label: "Exchange", value: exchange, defaultValue: ALL, options: EXCHANGE_OPTIONS, onChange: setExchange },
          ]}
        />
      );
      break;
    case "insolvency":
      list = (
        <InsolvencyList
          key="insolvency"
          {...common}
          country={country}
          kind={insolvencyKind}
          namePrefix={prefix}
          searching={searching}
          search={{
            value: query,
            onChange: (value: string) => setQuery(value.trim()),
            placeholder: "company name",
            focused,
            debounceMs: 300,
            normalizeValue: (value: string) => value.trim(),
            ...searchProps,
          }}
          onSearch={focusSearch}
          filters={[
            { id: "country", label: "Country", value: country, defaultValue: ALL, options: COUNTRY_OPTIONS, onChange: setCountry },
            { id: "procedure", label: "Procedure", value: insolvencyKind, defaultValue: ALL, options: INSOLVENCY_KIND_OPTIONS, onChange: setInsolvencyKind },
          ]}
        />
      );
      break;
  }

  return (
    <Box width={width} height={height} flexDirection="column">
      {header}
      {list}
    </Box>
  );
}

const distressFilingKind = (value: unknown): DistressFilingKind => (value === "listing" ? "listing" : "distress");
const verdictFilter = (value: unknown): GoingConcernVerdictFilter =>
  VERDICT_OPTIONS.some((option) => option.value === value) ? value as GoingConcernVerdictFilter : "doubt_raised";

interface ListProps {
  focused: boolean;
  width: number;
  height: number;
  /** Null when the source picker sits on the tab strip row instead of in the query bar. */
  viewControl: QueryBarView<DistressViewId> | null;
  filters: QueryBarFilter[];
}

const NO_ATTRIBUTIONS: DistressAttribution[] = [];

function FilingsList({ kind, ...props }: ListProps & { kind: DistressFilingKind }) {
  const loader = useCallback<Loader<CloudFilingEventPayload>>(async ({ force, signal }) => {
    const loaded = await loadDistressFilings(kind, force, signal);
    const rows = loaded.payload.events;
    return { rows, hasMore: false, nextOffset: rows.length, loaded, attributions: NO_ATTRIBUTIONS };
  }, [kind]);
  const spec = useMemo<RowSpec<CloudFilingEventPayload>>(() => ({
    getId: (event) => event.id,
    title: (event) => cellText(event.company.name),
    url: (event) => event.docUrl,
    ticker: (event) => {
      const symbol = filingTicker(event);
      return symbol ? { key: symbol, label: symbol } : null;
    },
    cell: (event, column, muted, base) => {
      switch (column) {
        case "filed": return { text: filingDate(event), color: muted };
        case "company": return { text: cellText(event.company.name), color: base };
        case "ticker": return { text: filingTicker(event) ?? MISSING, color: filingTicker(event) ? base : muted };
        case "event": return { text: filingEventLabel(event), color: base };
        case "headline": return { text: cellText(event.headline ?? ""), color: muted };
        default: return { text: "" };
      }
    },
    detail: (event, width) => <FilingDetail event={event} width={width} />,
  }), []);
  return (
    <DistressTable
      {...props}
      viewId="filings"
      loader={loader}
      spec={spec}
      columns={filingColumns(props.width)}
      subject="8-K filings"
      emptyTitle={kind === "listing" ? "No listing notices." : "No bankruptcy or obligation filings."}
    />
  );
}

function GoingConcernList({ verdict, ...props }: ListProps & { verdict: GoingConcernVerdictFilter }) {
  const loader = useCallback<Loader<GoingConcernDisclosure>>(async ({ offset, force, signal }) => {
    const loaded = await loadGoingConcern({
      verdict: verdict === "all" ? undefined : verdict,
      limit: PAGE_LIMIT,
      offset: offset || undefined,
    }, force, signal);
    const rows = loaded.payload.disclosures;
    return { rows, hasMore: canPage(loaded.payload.hasMore, offset + rows.length), nextOffset: offset + rows.length, loaded, attributions: NO_ATTRIBUTIONS };
  }, [verdict]);
  const spec = useMemo<RowSpec<GoingConcernDisclosure>>(() => ({
    getId: (row) => row.id,
    title: goingConcernTitle,
    url: (row) => row.filing_url,
    ticker: (row) => venueTicker(row.ticker),
    cell: (row, column, muted, base) => {
      switch (column) {
        case "filed": return { text: isoDay(row.filed_at), color: muted };
        case "company": return { text: goingConcernTitle(row), color: base };
        case "ticker": {
          const ticker = venueTicker(row.ticker);
          return { text: ticker?.label ?? MISSING, color: ticker ? base : muted };
        }
        case "form": return { text: row.form, color: muted };
        case "period": return { text: isoDay(row.period_end), color: muted };
        case "verdict": return { text: VERDICT_LABELS[row.verdict], color: row.verdict === "doubt_raised" ? base : muted };
        default: return { text: "" };
      }
    },
    detail: (row, width) => <GoingConcernDetail row={row} width={width} />,
    // The disclosures come from monthly SEC data sets, weeks behind the filings.
    footerInfo: (rows) => {
      const month = rows.reduce((latest, row) => (row.dataset_month > latest ? row.dataset_month : latest), "");
      const label = monthLabel(month);
      return label ? [{ id: "dataset", parts: [{ text: `SEC data set ${label}`, tone: "muted" }] }] : [];
    },
  }), []);
  return (
    <DistressTable
      {...props}
      viewId="going-concern"
      loader={loader}
      spec={spec}
      columns={goingConcernColumns(props.width, verdict)}
      subject="going-concern disclosures"
      emptyTitle="No disclosures."
      emptyHint="A company missing here may still have disclosed doubt."
    />
  );
}

function DesignationsList({ kind, exchange, ...props }: ListProps & { kind: string; exchange: string }) {
  const loader = useCallback<Loader<DistressDesignation>>(async ({ offset, force, signal }) => {
    const loaded = await loadDesignations({
      kind: unlessAll(kind),
      exchange: unlessAll(exchange),
      limit: PAGE_LIMIT,
      offset: offset || undefined,
    }, force, signal);
    const rows = loaded.payload.designations;
    return { rows, hasMore: canPage(loaded.payload.hasMore, offset + rows.length), nextOffset: offset + rows.length, loaded, attributions: loaded.payload.attributions };
  }, [exchange, kind]);
  const spec = useMemo<RowSpec<DistressDesignation>>(() => ({
    getId: (row) => row.id,
    title: (row) => `${designationName(row)} (${row.local_code})`,
    url: (row) => row.notice_url ?? row.source_url,
    ticker: designationTicker,
    cell: (row, column, muted, base) => {
      switch (column) {
        case "date": return { text: designationDate(row), color: row.date_basis === "first_observed" ? muted : base };
        case "basis": return { text: DATE_BASIS_LABELS[row.date_basis], color: muted };
        case "code": return { text: row.local_code, color: base };
        case "name": return { text: designationName(row), color: base };
        case "exchange": return { text: exchangeLabel(row.exchange), color: muted };
        case "status": {
          const label = designationKindLabel(row.kind);
          return row.ended_at
            ? { text: `${label}, ended ${isoDay(row.ended_at)}`, color: muted }
            : { text: label, color: base };
        }
        default: return { text: "" };
      }
    },
    detail: (row, width, attributions) => <DesignationDetail row={row} width={width} attributions={attributions} />,
    // Exchanges publish these lists daily; the newest sighting says how current the list is.
    footerInfo: (rows) => {
      const seen = rows.reduce((latest, row) => (row.last_seen_at > latest ? row.last_seen_at : latest), "");
      return seen ? [{ id: "seen", parts: [{ text: `as of ${isoDay(seen)}`, tone: "muted" }] }] : [];
    },
  }), []);
  return (
    <DistressTable
      {...props}
      viewId="listings"
      loader={loader}
      spec={spec}
      columns={designationColumns(props.width)}
      subject="listing designations"
      emptyTitle="No designations."
    />
  );
}

function InsolvencyList({ country, kind, namePrefix: prefix, search, searching, onSearch, ...props }: ListProps & {
  country: string;
  kind: string;
  namePrefix: string | undefined;
  search: QueryBarSearch;
  searching: boolean;
  onSearch: () => void;
}) {
  const loader = useCallback<Loader<InsolvencyNotice>>(async ({ offset, force, signal }) => {
    const loaded = await loadInsolvencyNotices({
      country: unlessAll(country),
      kind: unlessAll(kind),
      name_prefix: prefix,
      limit: PAGE_LIMIT,
      offset: offset || undefined,
    }, force, signal);
    const rows = loaded.payload.notices;
    return { rows, hasMore: canPage(loaded.payload.hasMore, offset + rows.length), nextOffset: offset + rows.length, loaded, attributions: loaded.payload.attributions };
  }, [country, kind, prefix]);
  const spec = useMemo<RowSpec<InsolvencyNotice>>(() => ({
    getId: insolvencyId,
    title: (row) => cellText(row.entity_name),
    url: (row) => row.notice_url,
    // No notice maps to a listed company yet.
    ticker: () => null,
    cell: (row, column, muted, base) => {
      switch (column) {
        case "published": return { text: isoDay(row.published_date), color: muted };
        case "company": return { text: cellText(row.entity_name), color: base };
        case "country": return { text: row.country, color: muted };
        case "registry": return { text: row.registry_id, color: muted };
        case "procedure": return { text: insolvencyProcedureCell(row), color: row.status === "active" ? base : muted };
        case "notice": return { text: insolvencyNoticeLabel(row, "short"), color: muted };
        default: return { text: "" };
      }
    },
    detail: (row, width, attributions) => <InsolvencyDetail row={row} width={width} attributions={attributions} />,
  }), []);
  const hints = useMemo<PaneHint[]>(() => [{ id: "distress-search", key: "/", label: "search", onPress: onSearch }], [onSearch]);
  return (
    <DistressTable
      {...props}
      viewId="insolvency"
      loader={loader}
      spec={spec}
      columns={insolvencyColumns(props.width)}
      subject="insolvency notices"
      search={search}
      searching={searching}
      extraHints={hints}
      emptyTitle={prefix ? `No notices for companies starting with ${prefix}.` : "No notices."}
      emptyHint="A company missing here may still be in insolvency proceedings."
    />
  );
}

function monthLabel(month: string): string | null {
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const date = new Date(`${month}-01T00:00:00Z`);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" })
    : null;
}

const NO_HINTS: PaneHint[] = [];

function DistressTable<Row>({
  viewId,
  focused,
  width,
  height,
  viewControl,
  filters,
  search,
  searching = false,
  extraHints = NO_HINTS,
  loader,
  spec,
  columns,
  subject,
  emptyTitle,
  emptyHint,
}: ListProps & {
  viewId: DistressViewId;
  search?: QueryBarSearch;
  searching?: boolean;
  extraHints?: PaneHint[];
  loader: Loader<Row>;
  spec: RowSpec<Row>;
  columns: DataTableColumn[];
  subject: string;
  emptyTitle: string;
  emptyHint?: string;
}) {
  const colors = useThemeColors();
  const { pinTicker } = usePluginTickerActions();
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`distress:${viewId}:selected`, null);
  // A closed detail is stored as "": pane state reads null as unset.
  const [storedOpen, setOpen] = usePluginPaneState<string>(`distress:${viewId}:open`, "");
  const openId = storedOpen || null;
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const paged = usePagedRows(loader, { getId: spec.getId });
  const rows = paged.rows;
  const firstPage = paged.pages[0] ?? null;
  const attributions = firstPage?.attributions ?? NO_ATTRIBUTIONS;
  const selected = rows.find((row) => spec.getId(row) === selectedId) ?? rows[0] ?? null;
  const openRow = openId ? rows.find((row) => spec.getId(row) === openId) ?? null : null;

  // A restored open record can sit past the first page: page on until it
  // arrives, and drop it only once every page is in without it.
  useEffect(() => {
    if (!openId || openRow || paged.status !== "loaded" || paged.loadingMore) return;
    if (paged.hasMore && !paged.moreError) paged.loadMore();
    else setOpen("");
  }, [openId, openRow, paged, setOpen]);

  const loadMore = useTableLoadMore(scrollRef, paged.hasMore && !openId, paged.loadMore);
  usePaneRefreshKey(paged.reload, { focused, enabled: !openId });
  // `fetchedAt` is when the first page was read, from the cache or the server.
  const loadedAt = firstPage ? firstPage.loaded.fetchedAt : null;
  useAutoRefresh(loadedAt, paged.reload);

  const current = openRow ?? selected;
  const ticker = current ? spec.ticker(current) : null;
  const openTicker = useCallback(() => {
    if (ticker) pinTicker(ticker.key, { floating: true });
  }, [pinTicker, ticker]);
  const hints = useMemo<PaneHint[]>(() => [
    ...(openId ? [] : extraHints),
    ...(ticker ? [{ id: "distress-ticker", key: "t", label: "icker", onPress: openTicker }] : []),
  ], [extraHints, openId, openTicker, ticker]);
  const info = useMemo<PaneFooterSegment[]>(() => [
    ...(spec.footerInfo && rows.length > 0 ? spec.footerInfo(rows) : []),
    ...(paged.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
    ...(paged.moreError ? [{ id: "more-error", parts: [{ text: paged.moreError.message, tone: "warning" as const }] }] : []),
  ], [paged.loadingMore, paged.moreError, rows, spec]);
  usePaneStatusLinkFooter({
    registrationId: "mna:distress",
    focused,
    url: current ? spec.url(current) : null,
    label: "source",
    loading: paged.loading && rows.length > 0,
    // Once rows are drawn, a failed refresh keeps them and says so here.
    error: rows.length > 0 ? paged.error?.message ?? firstPage?.loaded.refreshError ?? null : null,
    stale: firstPage?.loaded.stale ?? false,
    info,
    hints,
    showOpenHint: !!current,
  });

  const queryBar = <QueryBar width={width} search={search} filters={filters} view={viewControl ?? undefined} />;

  const renderCell = useCallback((row: Row, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    const muted = state.selected ? colors.selectedText : colors.textMuted;
    const base = state.selected ? colors.selectedText : colors.text;
    return spec.cell(row, column.id, muted, base);
  }, [colors, spec]);

  if (rows.length === 0 && (paged.loading || paged.error)) {
    return (
      <Box width={width} height={height} flexDirection="column">
        {queryBar}
        <PaneStatusBody
          loading={paged.loading}
          error={paged.error?.message ?? null}
          subject={subject}
          errorTitle={unavailableText(`${subject[0]!.toUpperCase()}${subject.slice(1)}`)}
          empty={false}
        />
      </Box>
    );
  }

  const detailWidth = Math.max(10, width - 2);
  return (
    <DataTableStackView<Row>
      focused={focused && !searching}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={rows}
      getItemKey={spec.getId}
      selection={{ kind: "id", selectedId: selected ? spec.getId(selected) : null, getId: spec.getId, onChange: (id) => setSelectedId(String(id)) }}
      onActivate={(row) => setOpen(spec.getId(row))}
      sortColumnId={null}
      sortDirection="desc"
      renderCell={renderCell}
      selectedTextOverridesCellColor
      scrollRef={scrollRef}
      onBodyScrollActivity={loadMore}
      resetScrollKey={`${viewId}:${filters.map((filter) => ("value" in filter ? String(filter.value) : "")).join(":")}:${search?.value ?? ""}`}
      emptyStateTitle={emptyTitle}
      emptyStateHint={emptyHint}
      detailOpen={!!openRow}
      onBack={() => setOpen("")}
      detailTitle={openRow ? spec.title(openRow) : undefined}
      detailScrollRef={detailScrollRef}
      detailContent={openRow ? (
        <DetailScrollBody ref={detailScrollRef} resetScrollKey={spec.getId(openRow)}>
          {spec.detail(openRow, detailWidth, attributions)}
        </DetailScrollBody>
      ) : null}
    />
  );
}
