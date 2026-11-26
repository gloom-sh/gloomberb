import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DataTableStackView,
  EmptyState,
  PaneStatusBody,
  QueryBar,
  useTableLoadMore,
  usePaneFooter,
  usePaneTabs,
  type DataTableCell,
  type DataTableColumn,
  type PaneHint,
  type SelectControl,
} from "../../../components";
import { useCompanyDataFooter, usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { isAccessDenied } from "../../../api-client/errors";
import type {
  MnaDeal,
  MnaDealsPayload,
  MnaRegionFilter,
  MnaStatusFilter,
  MnaTargetFilter,
} from "../../../api-client/mna";
import { usePlanAccess } from "../../../api-client/plan-access";
import { useAsyncResource, useAutoRefresh, usePaneSettingValue, usePluginPaneState, useShortcut } from "../../../public/react";
import { usePaneInstance } from "../../../state/app/context";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { blendHex, type ThemeColors } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps, TickerResearchTabProps } from "../../../types/plugin";
import { Box, Text, useUiCapabilities, type InputRenderable, type ScrollBoxRenderable } from "../../../ui";
import { compareSortValues, nextHeaderSort, type SortPreference } from "../../../utils/sort-values";
import { usePluginTickerActions } from "../../runtime";
import { useCloudAccessFooter } from "../shared/cloud-upgrade";
import { Blurred, UpgradeLabel } from "../shared/locked-rows";
import { useResearchCloudSession } from "../shared/research-cloud-session";
import { useQuoteBoard } from "../shared/use-quote-board";
import { appendMnaDeals, cachedMnaDeals, fetchMnaDeals, loadMnaDeals } from "./client";
import { MnaDealDetail, mnaDealTitle } from "./detail";
import { DistressBoard } from "./distress/pane";
import {
  annualizedMayBeBlank,
  dealSpread,
  dealsSymbol,
  emptyDealsTitle,
  expectedCloseDate,
  formatDealValue,
  formatExpectedClose,
  formatListDate,
  formatPercentShort,
  formatPrice,
  isMnaTermsView,
  legsApart,
  MISSING,
  MNA_TERMS_VIEWS,
  mnaTermsView,
  partyCell,
  spreadBasisLabel,
  stageLabel,
  termsLabel,
  type DealSpread,
  type MnaTermsView,
} from "./model";
import { formatFeedTime } from "../../../utils/datetime-format";
import { createDataTableCsv } from "../../../components/data-table/export";
import { logFailure } from "../../../utils/log-failure";

const STATUS_OPTIONS: { value: MnaStatusFilter; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "talks", label: "Talks" },
  { value: "completed", label: "Completed" },
  { value: "terminated", label: "Terminated" },
  { value: "all", label: "All" },
];
const TARGET_OPTIONS: { value: MnaTargetFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "public", label: "Public" },
  { value: "private", label: "Private" },
];
const REGION_OPTIONS: { value: MnaRegionFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "us", label: "US" },
  { value: "intl", label: "International" },
];

type ColumnId = "date" | "target" | "acquirer" | "terms" | "value" | "price" | "spread" | "annualized" | "basis" | "close" | "stage";

const COLUMNS: Record<ColumnId, DataTableColumn> = {
  date: { id: "date", label: "DATE", width: 8, align: "left" },
  target: { id: "target", label: "TARGET", width: 16, align: "left", flexGrow: 1 },
  acquirer: { id: "acquirer", label: "ACQUIRER", width: 16, align: "left", flexGrow: 1 },
  terms: { id: "terms", label: "TERMS", width: 18, align: "left" },
  value: { id: "value", label: "VALUE", width: 8, align: "right" },
  price: { id: "price", label: "PRICE", width: 9, align: "right" },
  spread: { id: "spread", label: "SPREAD", width: 7, align: "right" },
  annualized: { id: "annualized", label: "ANN.", width: 7, align: "right" },
  // What the spread's prices are: a session's closes (`Mon close`), or trades and when (`15:42`, `8h apart`).
  basis: { id: "basis", label: "AS OF", width: 12, align: "left" },
  close: { id: "close", label: "CLOSE", width: 7, align: "left" },
  stage: { id: "stage", label: "STAGE", width: 16, align: "left" },
};

/** The pending deals with no per-share terms are their own list: no price, no spread. */
type ColumnSet = MnaStatusFilter | "unpriced";

const COLUMNS_BY_STATUS: Record<ColumnSet, ColumnId[]> = {
  pending: ["date", "target", "acquirer", "terms", "value", "price", "spread", "annualized", "basis", "close", "stage"],
  // What the deal pays in, when it says (cash, stock), stands where the terms would be.
  unpriced: ["date", "target", "acquirer", "terms", "value", "close", "stage"],
  talks: ["date", "target", "acquirer", "value", "stage"],
  completed: ["date", "target", "acquirer", "terms", "value", "close"],
  terminated: ["date", "target", "acquirer", "terms", "value", "close"],
  all: ["date", "target", "acquirer", "terms", "value", "spread", "basis", "stage"],
};

/**
 * What goes first when the pane is too narrow for every column. The spread
 * never shows without what it is as of: AS OF goes only with it. The
 * announcement date goes before the expected close, which an arb reads.
 */
const DROP_ORDER: ColumnId[] = ["price", "date", "close", "value", "annualized", "terms", "stage", "acquirer", "spread"];

/** Columns that fit `width`; `targetWidth` widens the target column, e.g. for the unlock prompt. */
export function mnaColumns(status: ColumnSet, width: number, targetWidth = COLUMNS.target.width): DataTableColumn[] {
  const widthOf = (id: ColumnId) => (id === "target" ? Math.max(COLUMNS.target.width, targetWidth) : COLUMNS[id].width);
  let ids = [...COLUMNS_BY_STATUS[status]];
  const need = (list: ColumnId[]) => list.reduce((sum, id) => sum + widthOf(id) + 1, 0);
  for (const drop of DROP_ORDER) {
    if (need(ids) <= width) break;
    ids = ids.filter((id) => id !== drop && !(drop === "spread" && id === "basis"));
  }
  const ended = status === "completed" || status === "terminated";
  return ids.map((id) => ({
    ...COLUMNS[id],
    width: widthOf(id),
    ...(id === "close" && ended ? { label: "CLOSED" } : {}),
    ...(id === "terms" && status === "unpriced" ? { label: "CONSIDERATION" } : {}),
  }));
}

/**
 * One cell of a deal, at the spread its quotes give (null with no quote, or
 * for a deal that has none to read).
 *
 * A dash is marked as one that may be blank only where the deal itself says
 * nothing is owed:
 * - TERMS, VALUE and CLOSE of a deal in talks: nothing is agreed, so there are
 *   no terms, no announced value and no close to expect.
 * - PRICE, SPREAD and AS OF of a deal with no spread to read: it is not
 *   pending, its target is not listed, or it states no per-share terms.
 * - ANN. of such a deal, and of one with no annual figure to state at `now`:
 *   a partial offer or a close less than a day off, with a quote or without,
 *   and a quoted spread that is not positive (annualizedMayBeBlank). A full
 *   offer further from its close owes it, so a missing quote is still named.
 *
 * An agreed deal owes the rest, and the list cannot tell these apart from a
 * figure it lost: terms the parties did not disclose (`consideration:
 * "undisclosed"`, which is also what a deal reads as before its terms are
 * read), a value nobody announced (a null `value`), and a close the deal gives
 * no date for (a null `expectedClose` or `closed`). A capture whose every
 * agreed deal has none fails on that column.
 */
export function mnaDealCell(
  deal: MnaDeal,
  column: Pick<DataTableColumn, "id">,
  spread: DealSpread | null,
  colors: ThemeColors,
  selected = false,
  now = Date.now(),
): DataTableCell {
  const expectsSpread = deal.status === "pending" && !!deal.target.symbol && mnaTermsView(deal) === "priced";
  const agreed = deal.status !== "talks";
  const base = selected ? colors.selectedText : colors.text;
  const muted = selected ? colors.selectedText : colors.textMuted;
  switch (column.id) {
    case "date": return { text: formatListDate(deal.announced), color: muted };
    case "target": return { text: partyCell(deal.target, true), color: base };
    case "acquirer": return deal.acquirer ? { text: deal.acquirer.name, color: base } : { text: "Undisclosed", color: muted };
    case "terms": {
      const text = termsLabel(deal.terms);
      return { text, color: text === MISSING ? muted : base, mayBeBlank: !agreed };
    }
    case "value": return { text: formatDealValue(deal.value, deal.valueCurrency), color: base, mayBeBlank: !agreed };
    case "price":
      return { text: spread ? formatPrice(spread.price) : MISSING, color: spread ? base : muted, mayBeBlank: !expectsSpread };
    case "spread": {
      if (!spread) return { text: MISSING, color: muted, mayBeBlank: !expectsSpread };
      // Negative: the market expects better terms than the ones on the table.
      return { text: formatPercentShort(spread.spread), color: spread.spread < 0 && !selected ? colors.warning : base };
    }
    case "annualized": {
      const annualized = spread?.annualized ?? null;
      return annualized == null
        ? { text: MISSING, color: muted, mayBeBlank: !expectsSpread || annualizedMayBeBlank(deal, spread, now) }
        : { text: formatPercentShort(annualized), color: base };
    }
    case "basis": {
      if (!spread) return { text: MISSING, color: muted, mayBeBlank: !expectsSpread };
      // Trades too far apart to be one moment's take the warning tone every stale mark has.
      const apart = legsApart(spread.basis);
      return { text: spreadBasisLabel(spread.basis, (at) => formatFeedTime(at), now, { timed: false }), color: apart && !selected ? colors.warning : muted };
    }
    case "close": {
      const ended = deal.status === "completed" || deal.status === "terminated";
      return ended
        ? { text: deal.closed ? formatListDate(deal.closed) : MISSING, color: muted }
        : { text: formatExpectedClose(deal.expectedClose), color: deal.expectedClose ? base : muted, mayBeBlank: !agreed };
    }
    case "stage": {
      const tone = selected ? colors.selectedText
        : deal.status === "completed" ? colors.positive
          : deal.status === "terminated" ? colors.negative
            : deal.status === "talks" || deal.stale ? colors.textMuted
              : deal.hostile ? colors.warning
                : colors.text;
      return { text: stageLabel(deal), color: tone };
    }
    default: return { text: "" };
  }
}

/** Deals a split list loads, page after page, to fill its rows before the reader scrolls. */
const SPLIT_FILL_DEALS = 300;

const NO_DEALS: MnaDeal[] = [];

/** Placeholder rows standing for the deals a delayed list withholds. */
const MAX_LOCKED_ROWS = 2;

type Item = { kind: "deal"; deal: MnaDeal } | { kind: "locked"; index: number };

const itemKey = (item: Item) => (item.kind === "deal" ? item.deal.id : `locked:${item.index}`);

type MnaTab = "deals" | "distress";

const MNA_TABS: { label: string; value: MnaTab }[] = [
  { label: "Deals", value: "deals" },
  { label: "Distress", value: "distress" },
];

/** `MA`, or `MA ACVA`. A link supplies the ticker; an older pane still has it in settings. */
export function MnaPane(props: PaneProps) {
  const { symbol: bound, ticker: boundTicker } = usePaneTickerIdentity();
  const [ticker] = usePaneSettingValue("ticker", "");
  const fromSettings = typeof ticker === "string" ? ticker.trim().toUpperCase() : "";
  // Deals are filed under a listing's quote symbol (ATH.TO), not its bare symbol (ATH:TSX is not ATH).
  const symbol = dealsSymbol(bound, boundTicker?.metadata.exchange) || fromSettings;
  // One company's deals have no market-wide distress tab beside them.
  if (symbol) return <MnaDealsView key={symbol} focused={props.focused} width={props.width} height={props.height} symbol={symbol} />;
  return <MnaBoard focused={props.focused} width={props.width} height={props.height} />;
}

/**
 * The market-wide pane: deals, and companies in difficulty, the other side of
 * special situations. `DIST` opens it on the Distress tab. Only the active tab
 * is mounted, so the pane always has one table to export and the hidden deal
 * list keeps no quotes streaming.
 */
function MnaBoard({ focused, width, height }: { focused: boolean; width: number; height: number }) {
  const opensOnDistress = usePaneInstance()?.params?.tab === "distress";
  const [storedTab, setTab] = usePluginPaneState<string>("tab", opensOnDistress ? "distress" : "deals");
  const tab: MnaTab = storedTab === "distress" ? "distress" : "deals";
  const { strip, rows } = usePaneTabs({
    tabs: MNA_TABS,
    activeValue: tab,
    onSelect: setTab,
    focused,
    compact: true,
    variant: "bare",
  });
  // The terminal draws the strip; Distress puts its source picker on the same row.
  if (tab === "distress") return <DistressBoard focused={focused} width={width} height={height} tabStrip={strip} />;
  return (
    <Box width={width} height={height} flexDirection="column">
      {strip ? <Box height={1} flexShrink={0} paddingX={1} flexDirection="column">{strip}</Box> : null}
      <MnaDealsView focused={focused} width={width} height={Math.max(1, height - rows)} symbol={null} />
    </Box>
  );
}

export function MnaTickerTab({ focused, width, height }: TickerResearchTabProps) {
  const { ticker } = usePaneTickerIdentity();
  const symbol = dealsSymbol(ticker?.metadata.ticker, ticker?.metadata.exchange);
  if (!symbol) return <EmptyState title="Select a ticker." />;
  return <MnaDealsView key={symbol} focused={focused} width={width} height={height} symbol={symbol} />;
}

function MnaDealsView({ focused, width, height, symbol }: {
  focused: boolean;
  width: number;
  height: number;
  /** Deals where this company is the target or the buyer. */
  symbol: string | null;
}) {
  const colors = useThemeColors();
  const isDesktopWeb = useUiCapabilities().nativePaneChrome === true;
  const pro = usePlanAccess().hasProAccess;
  const session = useResearchCloudSession();
  const { pinTicker } = usePluginTickerActions();
  const prefix = symbol ? "ticker." : "";
  const [status, setStatus] = usePluginPaneState<MnaStatusFilter>(`${prefix}status`, symbol ? "all" : "pending");
  // Listed targets first: the spread is what makes the pending list worth opening.
  const [target, setTarget] = usePluginPaneState<MnaTargetFilter>(`${prefix}target`, "public");
  const [region, setRegion] = usePluginPaneState<MnaRegionFilter>(`${prefix}region`, "all");
  // Pending deals: the priced ones a spread is read on, or the ones announced without per-share terms.
  const [storedTerms, setTerms] = usePluginPaneState<MnaTermsView>(`${prefix}terms`, "priced");
  const termsView: MnaTermsView = isMnaTermsView(storedTerms) ? storedTerms : "priced";
  const split = status === "pending";
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>(`${prefix}selected`, null);
  // A closed detail is stored as "": pane state reads null as unset.
  const [storedOpen, setOpen] = usePluginPaneState<string>(`${prefix}open`, "");
  const openId = storedOpen || null;
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [searchFocus, setSearchFocus] = useState(0);
  const [sort, setSort] = useState<SortPreference<ColumnId>>({ columnId: null, direction: "desc" });
  const statusControl = useRef<SelectControl>(null);
  const searchInput = useRef<InputRenderable | null>(null);
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);

  const params = useMemo(() => ({
    status,
    target: symbol ? undefined : target,
    region: symbol ? undefined : region,
    symbol: symbol ?? undefined,
    query: query.trim() || undefined,
  }), [query, region, status, symbol, target]);
  const paramsKey = JSON.stringify(params);
  const loader = useCallback(
    (force: boolean) => loadMnaDeals(params, pro, force),
    // The session key reloads a list opened before sign-in or an upgrade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paramsKey, pro, session.requestKey],
  );
  const resource = useAsyncResource(loader, { initialData: () => cachedMnaDeals(params, pro), clearOnError: isAccessDenied });
  const first = resource.data?.payload ?? null;
  const [paged, setPaged] = useState<{ owner: MnaDealsPayload; payload: MnaDealsPayload } | null>(null);
  const data = paged && paged.owner === first ? paged.payload : first;
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRequest = useRef<AbortController | null>(null);

  const loadMore = useCallback(() => {
    if (!data?.hasMore || !first || loadingMore || openId) return;
    pageRequest.current?.abort();
    const request = new AbortController();
    pageRequest.current = request;
    setLoadingMore(true);
    void fetchMnaDeals({ ...params, offset: data.nextOffset }, undefined, request.signal)
      .then((page) => {
        if (pageRequest.current === request) setPaged({ owner: first, payload: appendMnaDeals(data, page) });
      })
      .catch((error) => {
        if (!request.signal.aborted) logFailure("mna.pane", "Load more M&A deals failed")(error);
      })
      .finally(() => {
        if (pageRequest.current === request) setLoadingMore(false);
      });
  }, [data, first, loadingMore, openId, params]);
  const onScroll = useTableLoadMore(scrollRef, !!data?.hasMore && !loadingMore && !openId, loadMore);

  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => resource.reload(), { focused, enabled: !openId });

  const allDeals = data?.deals ?? NO_DEALS;
  const deals = useMemo(() => (split ? allDeals.filter((deal) => mnaTermsView(deal) === termsView) : allDeals), [allDeals, split, termsView]);
  // The server pages every pending deal, priced or not: a split list asks for more until its rows fill the pane.
  const shortOfRows = split && !!data?.hasMore && deals.length < height && allDeals.length < SPLIT_FILL_DEALS;
  useEffect(() => {
    if (shortOfRows) loadMore();
  }, [loadMore, shortOfRows]);
  const quoteSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const deal of deals) {
      if (deal.status !== "pending" || !deal.target.symbol) continue;
      set.add(deal.target.symbol);
      if (deal.terms.exchangeRatio != null && deal.terms.ratioSymbol) set.add(deal.terms.ratioSymbol);
    }
    return [...set];
  }, [deals]);
  // The cursor starts on the first deal, and moves there when its deal leaves the list.
  const selected = deals.find((deal) => deal.id === selectedId) ?? deals[0] ?? null;
  const { quotes } = useQuoteBoard(quoteSymbols, { selectedSymbol: selected?.target.symbol ?? null });
  const spreadOf = useCallback((deal: MnaDeal) => {
    const quote = deal.target.symbol ? quotes.get(deal.target.symbol)?.quote ?? null : null;
    const ratio = deal.terms.ratioSymbol ? quotes.get(deal.terms.ratioSymbol)?.quote ?? null : null;
    return dealSpread(deal, quote, ratio);
  }, [quotes]);

  const sorted = useMemo(() => {
    if (!sort.columnId) return deals;
    const value = (deal: MnaDeal): string | number | null => {
      switch (sort.columnId) {
        case "date": return deal.announced;
        case "target": return partyCell(deal.target, true);
        case "acquirer": return deal.acquirer?.name ?? null;
        case "terms": return termsLabel(deal.terms);
        case "value": return deal.valueUsd;
        case "price": return spreadOf(deal)?.price ?? null;
        case "spread": return spreadOf(deal)?.spread ?? null;
        case "annualized": return spreadOf(deal)?.annualized ?? null;
        case "basis": {
          const basis = spreadOf(deal)?.basis;
          // As of when: a close at its New York evening, a trade at its time.
          return !basis ? null : basis.kind === "close" ? Date.parse(`${basis.session}T21:00:00Z`) : basis.at;
        }
        case "close": return deal.closed ?? expectedCloseDate(deal.expectedClose)?.toISOString().slice(0, 10) ?? null;
        case "stage": return stageLabel(deal);
        default: return null;
      }
    };
    return [...deals].sort((a, b) => compareSortValues(value(a), value(b), sort.direction));
  }, [deals, sort, spreadOf]);

  const locked = data?.access === "delayed" ? data.lockedDeals : 0;
  const lockedText = `Unlock ${locked} newer deal${locked === 1 ? "" : "s"}`;
  // The prompt sits in the target column, which widens to hold it.
  const columns = useMemo(
    () => mnaColumns(split && termsView === "unpriced" ? "unpriced" : status, width, locked > 0 ? Math.min(lockedText.length + 3, Math.floor(width / 3)) : undefined),
    [locked, lockedText, split, status, termsView, width],
  );
  // Export CSV keeps the columns an earlier export had where they were: AS OF, drawn beside the spread, comes last.
  const exportColumns = useMemo(
    () => [...columns.filter((column) => column.id !== "basis"), ...columns.filter((column) => column.id === "basis")],
    [columns],
  );
  const items = useMemo<Item[]>(() => [
    ...Array.from({ length: Math.min(MAX_LOCKED_ROWS, locked) }, (_, index) => ({ kind: "locked" as const, index })),
    ...sorted.map((deal) => ({ kind: "deal" as const, deal })),
  ], [locked, sorted]);

  const access = useCloudAccessFooter({
    delayLabel: `${data?.delayDays || 7}d`,
    focused,
    shortcutScope: "mna",
    placement: "ma-footer",
    degraded: data?.access === "delayed",
  });
  const openUpgrade = access.openUpgrade;

  const openSearch = useCallback(() => {
    setSearching(true);
    setSearchFocus((value) => value + 1);
  }, []);
  const openTarget = useCallback(() => {
    if (selected?.target.symbol) pinTicker(selected.target.symbol, { floating: true });
  }, [pinTicker, selected]);
  useShortcut((event) => {
    if (!focused || openId || searching || event.targetEditable || event.ctrl || event.meta || event.alt || event.super) return;
    if (event.name === "/") { event.preventDefault(); openSearch(); }
    if (event.name === "s") { event.preventDefault(); statusControl.current?.open(); }
    if (event.name === "t" && selected?.target.symbol) { event.preventDefault(); openTarget(); }
  });

  const hints = useMemo<PaneHint[]>(() => [
    { id: "mna-search", key: "/", label: "search", onPress: openSearch },
    { id: "mna-status", key: "s", label: "tatus", onPress: () => statusControl.current?.open() },
    ...(selected?.target.symbol ? [{ id: "mna-target", key: "t", label: "arget", onPress: openTarget }] : []),
    ...(access.hint ? [access.hint] : []),
  ], [access.hint, openSearch, openTarget, selected?.target.symbol]);
  usePaneStatusFooter({
    registrationId: "mna",
    enabled: !openId,
    loading: (resource.loading && !!data) || loadingMore,
    error: data ? resource.error ?? resource.data?.refreshError ?? null : null,
    stale: resource.data?.stale ?? false,
    hints,
  });
  usePaneFooter("mna:access", () => (access.segment && !openId ? { order: 5, info: [access.segment] } : null), [access.segment, openId]);
  // A receipt's or foreign line's deals include its company's, read from the home line.
  useCompanyDataFooter(data?.companyFrom, !openId);

  const placeholder = blendHex(colors.bg, colors.textMuted, 0.35);
  const renderCell = useCallback((item: Item, column: DataTableColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    if (item.kind === "locked") {
      if (column.id === "target" && item.index === 0) {
        return { text: lockedText, content: <UpgradeLabel text={lockedText} onPress={openUpgrade} role="mna-upgrade" />, onMouseDown: openUpgrade };
      }
      const size = Math.max(1, Math.min(column.width - 1, column.id === "target" || column.id === "acquirer" ? 9 + ((item.index * 5) % 6) : 5));
      if (isDesktopWeb) {
        const sample = column.id === "target" || column.id === "acquirer" ? "Hidden Company Inc".slice(0, size) : "$1.2B";
        return { text: "", content: <Blurred><Text fg={colors.textDim}>{sample}</Text></Blurred>, onMouseDown: openUpgrade };
      }
      return { text: "░".repeat(size), color: placeholder, onMouseDown: openUpgrade };
    }
    return mnaDealCell(item.deal, column, spreadOf(item.deal), colors, state.selected);
  }, [colors, isDesktopWeb, lockedText, openUpgrade, placeholder, spreadOf]);

  const openDeal = allDeals.find((deal) => deal.id === openId) ?? null;
  const queryBar = (
    <QueryBar
      width={width}
      search={{
        value: query,
        onChange: setQuery,
        placeholder: symbol ? "company" : "company or ticker",
        focused,
        active: searching,
        onActiveChange: setSearching,
        focusToken: searchFocus,
        inputRef: searchInput,
        debounceMs: 250,
      }}
      filters={[
        { id: "status", label: "Status", value: status, defaultValue: symbol ? "all" : "pending", options: STATUS_OPTIONS, onChange: setStatus, controlRef: statusControl },
        ...(split ? [{ id: "terms", label: "Terms", inline: true, value: termsView, options: MNA_TERMS_VIEWS, onChange: setTerms }] : []),
        ...(symbol ? [] : [
          { id: "target", label: "Target", value: target, defaultValue: "public", options: TARGET_OPTIONS, onChange: setTarget },
          { id: "region", label: "Region", value: region, defaultValue: "all", options: REGION_OPTIONS, onChange: setRegion },
        ]),
      ]}
    />
  );

  if (!data && !openId) {
    return (
      <Box width={width} height={height} flexDirection="column">
        {queryBar}
        <PaneStatusBody loading={resource.loading} error={resource.error} subject="M&A deals" empty={false} />
      </Box>
    );
  }

  return (
    <DataTableStackView<Item>
      focused={focused && !searching}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={items}
      getItemKey={itemKey}
      isNavigable={(item) => item.kind === "deal"}
      selection={{
        kind: "id",
        selectedId: selected?.id ?? null,
        getId: itemKey,
        onChange: (id) => { if (!String(id).startsWith("locked:")) setSelectedId(id); },
      }}
      onActivate={(item) => { if (item.kind === "deal") setOpen(item.deal.id); else openUpgrade(); }}
      sortable
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(id) => setSort((current) => nextHeaderSort(current, id as ColumnId, {
        firstDirection: id === "target" || id === "acquirer" || id === "stage" || id === "close" ? "asc" : "desc",
        resetTo: { columnId: null, direction: "desc" },
      }))}
      renderCell={renderCell}
      exportCsv={() => createDataTableCsv({ columns: exportColumns, items, renderCell })}
      scrollRef={scrollRef}
      onBodyScrollActivity={onScroll}
      resetScrollKey={`${paramsKey}:${split ? termsView : ""}`}
      emptyStateTitle={emptyDealsTitle(symbol, query, split ? termsView : null)}
      detailOpen={!!openId}
      onBack={() => setOpen("")}
      detailTitle={openDeal ? mnaDealTitle(openDeal) : undefined}
      detailContent={openId ? (
        <MnaDealDetail
          key={openId}
          id={openId}
          seed={openDeal}
          focused={focused}
          width={width}
          height={Math.max(4, height - 2)}
        />
      ) : null}
    />
  );
}
