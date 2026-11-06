import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { SocialOutlierCap, SocialOutlierRow, SocialOutliersPayload, SocialOutlierWindow } from "../../../api-client/social-mentions";
import {
  DataTableStackView,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
  type QueryBarFilter,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { ageFooterSegment } from "../../../components/layout/pane/footer";
import { useAsyncResource, useAutoRefresh, usePluginPaneState, useUpdatedAgo } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box } from "../../../ui";
import { compareSortValues, nextHeaderSort } from "../../../utils/sort-values";
import { SignInWall } from "../cloud/auth-actions";
import type { CloudResource } from "../shared/cloud-resource";
import { listingCell, missingCell, signedColor } from "../shared/research-cells";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { socialCount, socialRatio, socialStance, stanceWord } from "./model";
import { cachedSocialOutliers, DEFAULT_SOCIAL_OUTLIERS_QUERY, loadSocialOutliers, type SocialOutliersQuery } from "./outliers-client";
import {
  buildSocialOutlierColumns,
  outlierCountedAt,
  outlierDay,
  outlierPrice,
  SOCIAL_OUTLIER_CAP_OPTIONS,
  socialOutlierMinOptions,
  SOCIAL_OUTLIER_WINDOW_OPTIONS,
  socialOutlierDetailTitle,
  socialOutlierFirstDirection,
  socialOutliersEmptyTitle,
  socialOutliersFiltered,
  socialOutliersQueryFrom,
  socialOutlierSortValue,
  type SocialOutlierColumn,
  type SocialOutlierColumnId,
} from "./outliers-model";

/** A ticker opened from the ranking: BUZZ on its cashtag, in the ranking's stack. */
export interface SocialOpenedTicker {
  symbol: string;
  width: number;
  height: number;
  focused: boolean;
  /** A day opened in the ticker: Esc closes it before the ticker. */
  onDetailChange: (open: boolean) => void;
}

/** A ranking with the query it answers, so rows another query left on screen are told from this one's. */
interface SocialOutliersAnswer {
  query: SocialOutliersQuery;
  resource: CloudResource<SocialOutliersPayload>;
}

/** A multiple this high reads in the warning tone, as it does in the ticker's own days. */
const LOUD_RATIO = 2.5;

/**
 * BUZZ without a ticker: the tickers whose posts on X jump the most against
 * their own 30-day median, on each one's latest closed day or today so far,
 * with the stance of the day's top posts and the price move. Filters narrow
 * by posts and market value. Enter or a double click opens the ticker here as
 * BUZZ on its cashtag; Back or Esc returns to the same row.
 */
export function SocialOutliersView({ width, height, focused, renderTicker }: {
  width: number;
  height: number;
  focused: boolean;
  /** The ticker's BUZZ; the pane draws it, as it draws BUZZ on a ticker. */
  renderTicker: (ticker: SocialOpenedTicker) => ReactNode;
}) {
  const colors = useThemeColors();
  const session = useResearchCloudSession();
  // Each part of the query is its own pane state, so `gloom shot BUZZ --window today` sets them one by one.
  const [storedWindow, setWindow] = usePluginPaneState<SocialOutlierWindow>("social-mentions:outliers:window", DEFAULT_SOCIAL_OUTLIERS_QUERY.window);
  const [storedMin, setMin] = usePluginPaneState<number>("social-mentions:outliers:minPosts", DEFAULT_SOCIAL_OUTLIERS_QUERY.minPosts);
  const [storedCap, setCap] = usePluginPaneState<SocialOutlierCap | "all">("social-mentions:outliers:cap", "all");
  const query = useMemo(() => socialOutliersQueryFrom({ window: storedWindow, minPosts: storedMin, cap: storedCap }),
    [storedCap, storedMin, storedWindow]);
  const [selectedSymbol, setSelectedSymbol] = usePluginPaneState<string | null>("social-mentions:outliers:selected", null);
  // The opened ticker, with its company as it was opened, so the title keeps it when a refreshed ranking no longer lists it.
  const [openSymbol, setOpenSymbol] = usePluginPaneState<string | null>("social-mentions:outliers:open", null);
  const [openName, setOpenName] = usePluginPaneState<string | null>("social-mentions:outliers:openName", null);
  // The ticker's own day and cursor, which BUZZ on a ticker keeps: an opened ticker starts on its newest day.
  const [, setTickerDay] = usePluginPaneState<string | null>("social-mentions:open", null);
  const [, setTickerSelected] = usePluginPaneState<string | null>("social-mentions:selected", null);
  const [dayOpen, setDayOpen] = useState(false);
  const [sort, setSort] = useState<{ columnId: SocialOutlierColumnId; direction: "asc" | "desc" }>({ columnId: "ratio", direction: "desc" });

  const loader = useCallback(
    async (force: boolean): Promise<SocialOutliersAnswer> => ({ query, resource: await loadSocialOutliers(query, { force }) }),
    [query],
  );
  const resource = useAsyncResource(loader, {
    initialData: () => {
      const cached = cachedSocialOutliers(query);
      return cached ? { query, resource: cached } : null;
    },
    clearOnError: (error) => error instanceof Error && isCloudSessionRequired(error.message),
    // Another window or filter keeps the rows on screen, loading, until its own arrive.
    keepPreviousData: true,
  });
  // Rows another query left stay only while this one loads the first time: once it has failed, the body says so.
  const [failedQuery, setFailedQuery] = useState<SocialOutliersQuery | null>(null);
  const answered = resource.data?.query === query ? resource.data.resource : null;
  useEffect(() => {
    if (!answered && resource.error) setFailedQuery(query);
  }, [answered, query, resource.error]);
  const shown = answered ?? (resource.loading && failedQuery !== query ? resource.data?.resource ?? null : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  const detailOpen = !!openSymbol;
  // An opened ticker refreshes itself.
  usePaneRefreshKey(() => void resource.reload(), { focused, enabled: !detailOpen });
  // Signing in or out reads the ranking again for the new session.
  const sessionKeyRef = useRef(session.requestKey);
  const reload = resource.reload;
  useEffect(() => {
    if (sessionKeyRef.current === session.requestKey) return;
    sessionKeyRef.current = session.requestKey;
    void reload();
  }, [reload, session.requestKey]);

  const data = shown?.payload ?? null;
  // Rows of the other window, kept on screen while this one loads, keep their own columns.
  const dataWindow: SocialOutlierWindow = data?.window ?? query.window;
  const rows = data?.rows ?? [];
  const sortedRows = useMemo(() => {
    const order = new Map(rows.map((row, index) => [row.symbol, index]));
    return [...rows].sort((a, b) => (
      compareSortValues(socialOutlierSortValue(a, sort.columnId), socialOutlierSortValue(b, sort.columnId), sort.direction)
      || order.get(a.symbol)! - order.get(b.symbol)!
    ));
  }, [rows, sort]);
  const columns = useMemo(() => buildSocialOutlierColumns(width, rows, dataWindow), [dataWindow, rows, width]);
  // The ticker stays open while the ranking refreshes, ranked or not: it reads its own history.
  const openRow = openSymbol ? rows.find((row) => row.symbol === openSymbol) ?? null : null;
  const openTitle = openSymbol ? socialOutlierDetailTitle(openRow ?? { symbol: openSymbol, name: openName }) : "";
  const openTicker = useCallback((row: SocialOutlierRow) => {
    setSelectedSymbol(row.symbol);
    setTickerDay(null);
    setTickerSelected(null);
    setOpenName(row.name);
    setOpenSymbol(row.symbol);
  }, [setOpenName, setOpenSymbol, setSelectedSymbol, setTickerDay, setTickerSelected]);
  const closeTicker = useCallback(() => {
    setDayOpen(false);
    setOpenSymbol(null);
    setOpenName(null);
  }, [setOpenName, setOpenSymbol]);

  const updatedAgo = useUpdatedAgo(resource.updatedAt);
  usePaneStatusFooter({
    registrationId: "social-mentions:outliers",
    enabled: !detailOpen,
    loading: resource.loading,
    error: data ? resource.error : null,
    stale: !!data && !!shown?.stale,
    info: data && updatedAgo ? [ageFooterSegment(updatedAgo)] : [],
  });
  usePaneNoticeFooter({
    registrationId: "social-mentions:outliers:notices",
    focused,
    enabled: !detailOpen,
    notices: shown?.refreshError ? [shown.refreshError] : [],
  });

  const renderCell = useCallback((row: SocialOutlierRow, column: SocialOutlierColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    switch (column.id) {
      case "ticker": return listingCell(row.symbol, colors, state.selected);
      case "company": return row.name ? { text: row.name, color: colors.textMuted } : missingCell(colors);
      case "day": return { text: outlierDay(row), value: row.day, color: colors.textDim };
      case "countedAt": return { text: outlierCountedAt(row), value: row.countedAt, color: colors.textDim };
      case "mentions": return { text: socialCount(row.mentions), value: row.mentions, color: colors.text };
      case "baseline": return { text: socialCount(row.baseline), value: row.baseline, color: colors.textMuted };
      case "ratio": return { text: socialRatio(row.ratio), value: row.ratio, color: row.ratio >= LOUD_RATIO ? colors.warning : colors.text };
      case "stance": {
        if (row.stance == null) return missingCell(colors);
        const word = stanceWord(row.stance);
        return { text: socialStance(row.stance), value: row.stance, color: word === "bullish" ? colors.positive : word === "bearish" ? colors.negative : colors.text };
      }
      case "price": return row.price ? { text: outlierPrice(row), value: row.price.changePct, color: signedColor(row.price.changePct, colors) } : missingCell(colors);
    }
  }, [colors]);

  if (!data && isCloudSessionRequired(resource.error)) {
    return <SignInWall placement="social-outliers-signin" width={width} height={height} action="view social outliers" needsVerification={session.needsVerification} />;
  }

  const filters: QueryBarFilter[] = [
    {
      id: "window",
      label: "Window",
      title: "The day each ticker is counted on",
      value: query.window,
      options: SOCIAL_OUTLIER_WINDOW_OPTIONS,
      inline: true,
      onChange: (value: SocialOutlierWindow) => setWindow(value),
    },
    {
      id: "posts",
      label: "Posts",
      title: "Least posts on the day",
      value: String(query.minPosts),
      defaultValue: String(DEFAULT_SOCIAL_OUTLIERS_QUERY.minPosts),
      options: socialOutlierMinOptions(query.minPosts),
      onChange: (value: string) => setMin(Number(value)),
    },
    {
      id: "cap",
      label: "Cap",
      title: "Market value",
      value: query.cap ?? "all",
      defaultValue: "all",
      options: SOCIAL_OUTLIER_CAP_OPTIONS,
      onChange: (value: SocialOutlierCap | "all") => setCap(value),
    },
  ];
  const queryBar = <QueryBar width={width} filters={filters} />;
  const ticker = openSymbol
    ? renderTicker({ symbol: openSymbol, width, height: Math.max(3, height - 1), focused, onDetailChange: setDayOpen })
    : null;
  if (!data && !detailOpen) {
    // Loading, or a failure: the query bar stays above, so another window or filter is one click away.
    return (
      <Box flexDirection="column" width={width} height={height}>
        {queryBar}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error}
          retry={{ onRetry: () => void resource.reload(), pending: resource.loading }}
          subject="social outliers"
        />
      </Box>
    );
  }

  return (
    <DataTableStackView<SocialOutlierRow, SocialOutlierColumn>
      // Its keys pass to an open day first, so Esc closes that before the ticker.
      focused={focused && !dayOpen}
      detailOpen={detailOpen}
      onBack={closeTicker}
      detailTitle={openTitle || undefined}
      detailContent={ticker}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={sortedRows}
      getItemKey={(row) => row.symbol}
      selection={{
        kind: "id",
        selectedId: selectedSymbol,
        getId: (row) => row.symbol,
        onChange: (symbol) => setSelectedSymbol(symbol),
      }}
      onActivate={openTicker}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as SocialOutlierColumnId, {
        firstDirection: socialOutlierFirstDirection,
      }))}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
      emptyStateTitle={data
        ? socialOutliersEmptyTitle(data.window, data.freshFrom, socialOutliersFiltered(query))
        : resource.loading ? "Loading social outliers..." : "Social outliers unavailable."}
    />
  );
}
