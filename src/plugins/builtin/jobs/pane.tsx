import { useCallback, useEffect, useMemo, useRef } from "react";
import { useAppendedPages } from "./pages";
import type { CloudJobsMoverPayload, CloudJobsPosting, CloudJobsSummaryPayload } from "../../../api-client/types";
import {
  chartTableChromeRows,
  Badge,
  Button,
  ChartTableHeader,
  CompositeChart,
  DataTableStackView,
  DataTableView,
  EmptyState,
  PaneStatusBody,
  SectionHeading,
  scalarPoint,
  staticSeries,
  Tabs,
  useChartTableLayout,
  usePaneFooter,
  usePaneNoticeFooter,
  useTableLoadMore,
  type ChartTableHeaderProps,
  type DataTableCell,
  type PaneFooterSegment,
  type StatItem,
} from "../../../components";
import { compositeAxisTicks } from "../../../components/chart/composite/format";
import { statToneColor } from "../../../components/ui/stat-grid";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import type { ResolvedSeries } from "../../../time-series/types";
import { handleRefreshKey, usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { formatNumber } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { nextHeaderSort } from "../../../utils/sort-values";
import { ProWall, SignInWall } from "../cloud/auth-actions";
import { usePlanAccess } from "../../../api-client/plan-access";
import { usePluginPaneState, usePluginTickerActions } from "../../runtime";
import { fetchJobs, fetchJobsMovers, fetchJobsPostings, type JobsCompanyState } from "./client";
import {
  DEFAULT_MOVER_SORT,
  DEFAULT_POSTING_SORT,
  buildAgeBars,
  buildMoverColumns,
  buildMoverRows,
  buildPostingColumns,
  buildPostingRows,
  buildShareBars,
  changeTone,
  formatChange,
  formatCollectedAgo,
  formatSalaryRange,
  formatShare,
  historyChartPoints,
  moversHaveWeekHistory,
  sortMoverRows,
  sortPostingRows,
  type MoverColumn,
  type MoverColumnId,
  type MoverRow,
  type MoverSort,
  type PostingColumn,
  type PostingColumnId,
  type PostingRow,
  type PostingSort,
  type ShareBarRow,
} from "./model";
import { ShareBars } from "./share-bars";
import { usePaneTickerIdentity } from "../../../state/hooks/pane-ticker";
import { listingIdentity } from "../shared/ticker-request";

export const JOBS_PANE_ID = "jobs";

const PENDING_POLL_MS = 20_000;
const POSTINGS_PAGE = 100;
const MOVERS_PAGE = 200;

type DetailTab = "roles" | "locations" | "seniority" | "salary";

function HiringProWall({ symbol, exchange, width, height }: { symbol: string | null; exchange?: string; width: number; height: number }) {
  return (
    <ProWall
      placement="jobs-wall"
      symbol={symbol} exchange={exchange} width={width} height={height}
      title="Hiring data is part of Gloom Cloud Pro."
      message={`Gloomberb reads every listed company's own careers system daily: open roles over time, hiring by function and location, new roles, and pay ranges.${symbol ? ` Open ${symbol}'s hiring picture with Pro.` : ""}`}
    />
  );
}

// Company view ----------------------------------------------------------------

/**
 * The company's figures, most important first: a short pane keeps the first
 * ones. Details only fit beside the figures in a wide pane; elsewhere they
 * would cost the grid a column.
 */
function companyFigures(summary: CloudJobsSummaryPayload, width: number): StatItem[] {
  const trend = summary.change30d;
  const roomy = width >= 134;
  return [
    {
      id: "open",
      label: "Open roles",
      value: formatNumber(summary.openCount, 0),
      detail: roomy && summary.openPerThousandEmployees != null ? `${formatNumber(summary.openPerThousandEmployees, 1)}/1k staff` : undefined,
    },
    trend
      ? { id: "change", label: "30 days", value: formatChange(trend), tone: changeTone(trend.count) }
      : summary.posted30d != null
        ? { id: "posted", label: "Posted 30d", value: formatNumber(summary.posted30d, 0) }
        : { id: "closed", label: "Closed 30d", value: formatNumber(summary.closed30d, 0) },
    { id: "new", label: "New 7d", value: formatNumber(summary.new7d, 0), detail: roomy && summary.coverage.daysObserved <= 1 ? "first read" : undefined },
    { id: "remote", label: "Remote", value: summary.remoteShare != null ? formatShare(summary.remoteShare) : "-" },
    { id: "age", label: "Median age", value: summary.medianAgeDays != null ? `${summary.medianAgeDays}d` : "-" },
    // Standing roles the company hires for continuously; the rest are the
    // openings that say something about its plans.
    {
      id: "evergreen",
      label: "Evergreen",
      value: summary.evergreenShare != null ? formatShare(summary.evergreenShare) : "-",
      detail: roomy && summary.evergreenCount != null && summary.evergreenShare != null
        ? `${formatNumber(Math.max(0, summary.openCount - summary.evergreenCount), 0)} specific`
        : undefined,
    },
    { id: "contract", label: "Contract", value: summary.contractShare != null ? formatShare(summary.contractShare) : "-" },
  ];
}

const COMPACT_AXIS_UNITS = [[1e9, "B"], [1e6, "M"], [1e3, "k"]] as const;
const OPEN_ROLES_PANELS = [{ id: "main" }];
const formatOpenRoles = (value: number) => formatNumber(value, 0);

/**
 * Open-role counts on the chart axis. Below 10k they read as whole counts
 * (2,025 / 2,000 / 1,975), where 1.9k would repeat down the gutter; above
 * that, compact with the decimals the tick step needs (160.0k / 159.5k).
 */
export function formatOpenRolesAxisValue(value: number, domain: CompositeAxisDomain): string {
  const magnitude = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  if (magnitude < 10_000) return formatNumber(Math.round(value), 0);
  const [divisor, suffix] = COMPACT_AXIS_UNITS.find(([unit]) => magnitude >= unit)!;
  const ticks = compositeAxisTicks(domain, String).map((tick) => tick.value);
  const gap = Math.min(...ticks.slice(1).map((tick, index) => Math.abs(tick - ticks[index]!)));
  const decimals = Number.isFinite(gap) && gap > 0 ? Math.min(3, Math.max(0, Math.ceil(-Math.log10(gap / divisor) - 1e-9))) : 1;
  return `${formatNumber(value / divisor, decimals)}${suffix}`;
}

function openRolesColor(summary: CloudJobsSummaryPayload): string {
  const tone = changeTone(summary.change30d?.count ?? summary.change90d?.count);
  return tone === "positive" ? colors.positive : tone === "negative" ? colors.negative : colors.borderFocused;
}

/**
 * The open-roles line once a week of daily reads exists, on an axis cut to
 * the range it moves in; before that, the backlog by posting age, which is the
 * one thing a first read can say honestly about time. The by-function bars sit
 * beside it in a wide pane.
 */
function OpenRolesBand({ summary, series, functionRows, width, height, wide }: {
  summary: CloudJobsSummaryPayload;
  series: ResolvedSeries[] | null;
  functionRows: ShareBarRow[];
  width: number;
  height: number;
  wide: boolean;
}) {
  const ageRows = useMemo(() => buildAgeBars(summary), [summary]);
  const chartWidth = wide ? Math.floor(width * 0.58) : width;
  const barsWidth = wide ? width - chartWidth - 1 : 0;
  return (
    <Box flexDirection="row" width={width} height={height} gap={wide ? 1 : 0}>
      {series ? (
        <CompositeChart
          series={series}
          panels={OPEN_ROLES_PANELS}
          width={chartWidth}
          height={height}
          focused={false}
          navigable={false}
          showLegend
          showTimeAxis
          formatValue={formatOpenRoles}
          formatAxisValue={formatOpenRolesAxisValue}
          remoteKind="jobs-open-roles"
        />
      ) : (
        <Box flexDirection="column" width={chartWidth} height={height} paddingX={1}>
          <Box height={1}>
            <SectionHeading title="Open roles by posting age" />
          </Box>
          {ageRows.length === 0 ? (
            <Text fg={colors.textDim}>
              {summary.datesReliable === false ? "No reliable posting dates." : "This careers system publishes no posting dates."}
            </Text>
          ) : (
            <ShareBars rows={ageRows} width={Math.max(24, chartWidth - 2)} color={colors.borderFocused} />
          )}
        </Box>
      )}
      {wide ? (
        <Box flexDirection="column" width={barsWidth} height={height} paddingX={1} overflow="hidden">
          <SectionHeading title="By function" />
          <ShareBars rows={functionRows} width={barsWidth - 2} showDelta />
        </Box>
      ) : null}
    </Box>
  );
}

/** The tags worth a badge: at least two roles and 2% of the open ones. */
function signalTags(summary: CloudJobsSummaryPayload) {
  return summary.tags.filter((tag) => tag.count >= Math.max(2, summary.openCount * 0.02)).slice(0, 6);
}

function Signals({ summary }: { summary: CloudJobsSummaryPayload }) {
  const tags = signalTags(summary);
  if (tags.length === 0) return null;
  return (
    <Box flexDirection="row" paddingX={1} height={1} gap={1} overflow="hidden">
      {tags.map((tag) => (
        <Badge key={tag.id} label={`${tag.label} ${tag.count}`} tone={tag.id === "ai_ml" ? "accent" : "neutral"} />
      ))}
    </Box>
  );
}

function SalaryPanel({ summary, width }: { summary: CloudJobsSummaryPayload; width: number }) {
  const salary = summary.salary;
  if (!salary) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text fg={colors.textDim}>No pay ranges in the postings collected so far.</Text>
      </Box>
    );
  }
  const rows = buildShareBars(
    salary.byFunction.map((band) => ({ id: band.id, label: band.label, count: band.count, share: band.count / salary.count, previous: null })),
    8,
  );
  const bandFor = new Map(salary.byFunction.map((band) => [band.id, band]));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box height={1} flexDirection="row">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>
          {formatSalaryRange(salary.medianMin, salary.medianMax, salary.currency, salary.period)}
        </Text>
        <Text fg={colors.textDim}>{`  median range across ${formatNumber(salary.count, 0)} postings with published pay`}</Text>
      </Box>
      <Box height={1} />
      {rows.filter((row) => row.key !== "rest").map((row) => {
        const band = bandFor.get(row.key);
        return (
          <Box key={row.key} flexDirection="row" height={1}>
            <Box width={Math.min(20, Math.floor(width * 0.3))} flexShrink={0} overflow="hidden">
              <Text fg={colors.text}>{row.label}</Text>
            </Box>
            <Box width={22} flexShrink={0}>
              <Text fg={colors.textBright}>{band ? formatSalaryRange(band.medianMin, band.medianMax, salary.currency, salary.period) : ""}</Text>
            </Box>
            <Text fg={colors.textDim}>{`${row.count} postings`}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

const DETAIL_TABS: Array<{ label: string; value: DetailTab }> = [
  { label: "Roles", value: "roles" },
  { label: "Locations", value: "locations" },
  { label: "Seniority", value: "seniority" },
  { label: "Pay", value: "salary" },
];

function CompanyView({
  summary,
  width,
  height,
  focused,
  loading,
  error,
  registrationId,
  embedded,
}: {
  summary: CloudJobsSummaryPayload;
  width: number;
  height: number;
  focused: boolean;
  loading: boolean;
  error: string | null;
  registrationId: string;
  /** Inside Ticker Research, whose own tab strip owns h/l and the arrows. */
  embedded: boolean;
}) {
  const rendererHost = useRendererHost();
  const [tab, setTab] = usePluginPaneState<DetailTab>("jobs:tab", "roles");
  const [sort, setSort] = usePluginPaneState<PostingSort>("jobs:sort", DEFAULT_POSTING_SORT);
  // Keyed by posting, not by position, so a reload or a shared layout keeps the row.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("rolesSelectedKey", null);
  const rolesScrollRef = useRef<ScrollBoxRenderable | null>(null);

  // The summary carries the newest 40 roles; the rest page in on scroll.
  const loadPostingsPage = useCallback(
    (offset: number) => fetchJobsPostings(summary.ticker, { limit: POSTINGS_PAGE, offset }).then((page) => page.postings),
    [summary.ticker],
  );
  const more = useAppendedPages<CloudJobsPosting>(
    `${summary.ticker}:${summary.coverage.lastCollectedAt ?? ""}`,
    summary.recent.length,
    summary.openCount,
    loadPostingsPage,
  );
  const postings = useMemo(() => [...summary.recent, ...more.items], [summary.recent, more.items]);
  const loadMoreFromScroll = useTableLoadMore(rolesScrollRef, tab === "roles" && more.hasMore && !more.loadingMore, more.loadMore);

  const rows = useMemo(() => sortPostingRows(buildPostingRows(postings), sort), [postings, sort]);
  const hasSalary = postings.some((posting) => posting.salaryMin != null || posting.salaryMax != null);
  const columns = useMemo(() => buildPostingColumns(width, hasSalary), [width, hasSalary]);
  const functionRows = useMemo(() => buildShareBars(summary.functions, 7), [summary]);
  const countryRows = useMemo(() => buildShareBars(summary.countries, 12), [summary]);
  const seniorityRows = useMemo(() => buildShareBars(summary.seniority, 8), [summary]);

  const selectedIdx = Math.max(0, rows.findIndex((row) => row.key === selectedKey));
  const selected = rows[selectedIdx] ?? null;
  const openSelected = useCallback(() => {
    if (selected?.posting.url) void rendererHost.openExternal(selected.posting.url);
  }, [rendererHost, selected]);

  const cycleTab = useCallback(() => {
    const index = DETAIL_TABS.findIndex((entry) => entry.value === tab);
    setTab(DETAIL_TABS[(index + 1) % DETAIL_TABS.length]!.value);
  }, [setTab, tab]);

  useShortcut((event) => {
    if (!focused) return;
    if (isPlainKey(event, "o") && tab === "roles") {
      event.preventDefault?.();
      event.stopPropagation?.();
      openSelected();
    } else if (isPlainKey(event, "c") && summary.coverage.careersUrl) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void rendererHost.openExternal(summary.coverage.careersUrl);
    } else if (isPlainKey(event, "1", "2", "3", "4")) {
      // The research pane's strip keeps h/l, so the sections have their own keys.
      event.preventDefault?.();
      event.stopPropagation?.();
      setTab(DETAIL_TABS[Number(event.name) - 1]!.value);
    }
  });

  usePaneFooter(registrationId, () => {
    const info: PaneFooterSegment[] = [];
    if (loading) info.push({ id: "loading", parts: [{ text: "refreshing", tone: "muted" }] });
    if (more.loadingMore) info.push({ id: "loading-more", parts: [{ text: "loading more roles", tone: "muted" }] });
    if (error) info.push({ id: "error", parts: [{ text: error.slice(0, 60), tone: "warning" }] });
    // The careers platform is where the roles were read, not what they are,
    // so the footer says only when; `c` opens the company's own site.
    const collected = formatCollectedAgo(summary.coverage.lastCollectedAt);
    if (collected) {
      info.push({ id: "source", parts: [{ text: `read ${collected}`, tone: "muted" }] });
    }
    if (summary.coverage.daysObserved > 1) {
      info.push({ id: "history", parts: [{ text: `${summary.coverage.daysObserved}d of history`, tone: "muted" }] });
    }
    const hints = [
      ...(tab === "roles" && selected?.posting.url ? [{ id: "open", key: "o", label: "pen role", onPress: openSelected }] : []),
      ...(summary.coverage.careersUrl
        ? [{ id: "careers", key: "c", label: "areers site", onPress: () => void rendererHost.openExternal(summary.coverage.careersUrl!) }]
        : []),
      // The key is a range, so it is bound above; a click steps to the next section.
      ...(embedded ? [{ id: "section", key: "1-4", label: "section", title: "Next Section", onPress: cycleTab }] : []),
    ];
    return { info, hints };
  }, [loading, more.loadingMore, error, summary, tab, selected, openSelected, rendererHost, embedded, cycleTab]);

  // Unstable dates are a limitation of every age on screen, so they sit
  // behind the footer notice rather than a standing line under the chart.
  usePaneNoticeFooter({
    registrationId: `${registrationId}:notices`,
    notices: summary.datesReliable === false
      ? ["Posting dates on this careers system change on every read, so posting ages are not shown."]
      : [],
    focused,
  });

  const renderCell = useCallback((row: PostingRow, column: PostingColumn): DataTableCell => {
    switch (column.id) {
      case "title":
        return { text: row.title, color: colors.textBright };
      case "function":
        return { text: row.seniority && width >= 96 ? `${row.function} · ${row.seniority}` : row.function, color: colors.text };
      case "location":
        return { text: row.location, color: colors.textDim };
      case "posted":
        return { text: row.posted, color: row.posting.postedAt && !row.posted.includes("mo") ? colors.text : colors.textDim };
      case "salary":
        return { text: row.salary, color: colors.positive };
    }
  }, [width]);

  const wide = width >= 96;
  const series = useMemo(() => {
    const points = historyChartPoints(summary);
    return points ? [staticSeries(points.map((point) => scalarPoint(point.date, point.close)), {
      id: "open-roles", label: "Open roles", color: openRolesColor(summary), calendarSpaced: true,
    })] : null;
  }, [summary]);
  // Before a week of reads the band is a few posting-age bars, not a chart:
  // it takes the rows they need and the roles list gets the rest.
  const ageRowCount = useMemo(() => buildAgeBars(summary).length, [summary]);
  const barsRows = series ? undefined : 1 + Math.max(1, ageRowCount, wide ? functionRows.length : 0);
  // The kit sizes the band over the roles list, so a short pane keeps the
  // roles and the band gives way to the strip, then to nothing. The other
  // tabs share the same band so it does not jump between them.
  const header: Omit<ChartTableHeaderProps, "height"> = {
    width,
    tableRows: rows.length,
    tableChromeRows: chartTableChromeRows(columns, width),
    figures: companyFigures(summary, width),
    chart: {
      render: (size) => (
        <OpenRolesBand summary={summary} series={series} functionRows={functionRows} width={size.width} height={size.height} wide={wide} />
      ),
      maxRows: barsRows,
      minRows: barsRows ? Math.min(barsRows, 3) : undefined,
      strip: series ? {
        label: "Open roles",
        values: series[0]!.points.map((point) => point.value ?? 0),
        value: formatOpenRoles(summary.openCount),
        color: series[0]!.color,
      } : null,
    },
  };
  // The tag badges are a row of their own, kept while the band has its full chart.
  const tabRows = 1;
  const withSignals = useChartTableLayout({ ...header, height: height - tabRows - 1 });
  const signalsHeight = signalTags(summary).length > 0 && withSignals.mode === "full" ? 1 : 0;
  const bodyHeight = Math.max(1, height - tabRows - signalsHeight);
  const layout = useChartTableLayout({ ...header, height: bodyHeight });
  const bandRows = layout.mode === "full" ? layout.chartRows : layout.mode === "strip" ? 1 : 0;
  const lowerHeight = Math.max(1, bodyHeight - layout.figureRows - bandRows);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <ChartTableHeader {...header} height={bodyHeight} />
      {signalsHeight ? <Signals summary={summary} /> : null}
      <Box height={1} paddingX={1} flexShrink={0}>
        <Tabs
          tabs={DETAIL_TABS}
          activeValue={tab}
          onSelect={(value) => setTab(value as DetailTab)}
          compact
          variant="underline"
          focused={focused}
          keyboardNavigation={!embedded}
        />
      </Box>
      <Box flexGrow={1} flexBasis={0} minHeight={0} height={lowerHeight}>
        {tab === "roles" ? (
          <DataTableView<PostingRow, PostingColumn>
            focused={focused}
            scrollRef={rolesScrollRef}
            onBodyScrollActivity={loadMoreFromScroll}
            selection={{ kind: "index", selectedIndex: rows.length ? selectedIdx : -1, onChange: (_index, row) => setSelectedKey(row.key) }}
            onActivate={() => openSelected()}
            rootWidth={width}
            rootHeight={lowerHeight}
            columns={columns}
            freezeFirstColumn
            items={rows}
            sortColumnId={sort.columnId}
            sortDirection={sort.direction}
            onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as PostingColumnId, {
              firstDirection: columnId === "title" || columnId === "location" || columnId === "function" ? "asc" : "desc",
            }))}
            getItemKey={(row) => row.key}
            renderCell={renderCell}
            selectedTextOverridesCellColor
            emptyStateTitle="No open roles"
          />
        ) : tab === "locations" ? (
          <Box flexDirection="column" paddingX={1} paddingTop={1}>
            {countryRows.length === 0
              ? <Text fg={colors.textDim}>No locations in the postings collected so far.</Text>
              : <ShareBars rows={countryRows} width={Math.min(width - 2, 80)} color={colors.warning} showDelta />}
          </Box>
        ) : tab === "seniority" ? (
          <Box flexDirection="column" paddingX={1} paddingTop={1}>
            <ShareBars rows={seniorityRows} width={Math.min(width - 2, 80)} color={colors.neutral} showDelta />
            {!wide ? (
              <Box flexDirection="column" marginTop={1}>
                <SectionHeading title="By function" />
                <ShareBars rows={functionRows} width={Math.min(width - 2, 80)} showDelta />
              </Box>
            ) : null}
          </Box>
        ) : (
          <SalaryPanel summary={summary} width={width} />
        )}
      </Box>
    </Box>
  );
}

/**
 * One company's hiring, loaded and rendered with every state a pane needs.
 * Used by the ticker-bound pane, the research tab, and the detail page of
 * the coverage table.
 */
function CompanyPanel({
  symbol,
  exchange = "US",
  companyName,
  width,
  height,
  focused,
  registrationId,
  embedded = false,
}: {
  symbol: string;
  exchange?: string;
  companyName: string | null;
  width: number;
  height: number;
  focused: boolean;
  registrationId: string;
  embedded?: boolean;
}) {
  const request = useCallback(
    (force: boolean) => fetchJobs(symbol, { name: companyName, force }),
    [symbol, companyName],
  );
  const resource = useAsyncResource<JobsCompanyState>(request);
  const { data, status, error, reload } = resource;

  // `r` asks again in every state, including a failed or uncovered company.
  usePaneRefreshKey(reload, { focused });

  // While the server is looking for the company, ask again on a timer.
  useEffect(() => {
    if (data?.kind !== "pending") return;
    const timer = setTimeout(() => reload(), PENDING_POLL_MS);
    return () => clearTimeout(timer);
  }, [data, reload]);

  if (data?.kind === "denied") {
    if (data.status === 402) return <HiringProWall symbol={symbol} exchange={exchange} width={width} height={height} />;
    return <SignInWall placement="jobs-detail-signin" width={width} height={height} symbol={symbol} exchange={exchange} action="see who is hiring" needsVerification={data.status === 403} />;
  }
  if ((status === "idle" || status === "loading") && !data) {
    return <PaneStatusBody loading align="center" loadingLabel={`Loading ${symbol} hiring...`} />;
  }
  if (status === "error" && !data) {
    return <PaneStatusBody error={error ?? "Could not load hiring data."} errorTitle="Could not load hiring data." actions={<Button label="Try again" onPress={reload} />} />;
  }
  if (!data) return null;
  if (data.kind === "pending") {
    return (
      <PaneStatusBody
        loading
        align="center"
        loadingLabel={`Looking for ${symbol}'s careers system. First read lands within a few minutes.`}
      />
    );
  }
  if (data.kind === "uncovered") {
    return (
      <EmptyState
        title={`No careers system found for ${symbol}.`}
        message="Gloomberb reads companies' own careers systems. This one either has none we can read or lists roles only on third-party job boards."
        actions={<Button label="Look again" onPress={reload} />}
      />
    );
  }
  return (
    <CompanyView
      summary={data.summary}
      width={width}
      height={height}
      focused={focused}
      loading={status === "loading"}
      error={status === "error" ? error : null}
      registrationId={registrationId}
      embedded={embedded}
    />
  );
}

// Coverage home ------------------------------------------------------------------

/**
 * Every company under coverage, ranked; opening a row shows that company's
 * hiring in place, the way a feed opens a story.
 */
function HomeView({ width, height, focused, registrationId }: { width: number; height: number; focused: boolean; registrationId: string }) {
  const { nativePaneChrome } = useUiCapabilities();
  const { navigateTicker } = usePluginTickerActions();
  const request = useCallback(() => fetchJobsMovers(undefined, MOVERS_PAGE), []);
  const resource = useAsyncResource(request);
  const { data, status, error, reload } = resource;
  const [sort, setSort] = usePluginPaneState<MoverSort>("jobs:movers-sort", DEFAULT_MOVER_SORT);
  // Keyed by company, not by position, so a reload or a shared layout keeps the row.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("moversSelectedKey", null);
  const [open, setOpen] = usePluginPaneState<string | null>("jobs:open", null);
  const tableScrollRef = useRef<ScrollBoxRenderable | null>(null);

  const loadMoversPage = useCallback(
    (offset: number) => fetchJobsMovers(undefined, MOVERS_PAGE, offset).then((page) => page.movers),
    [],
  );
  const more = useAppendedPages<CloudJobsMoverPayload>(
    data?.asOf ?? "",
    data?.movers.length ?? 0,
    data?.total ?? data?.movers.length ?? 0,
    loadMoversPage,
  );
  const movers = useMemo(() => [...(data?.movers ?? []), ...more.items], [data, more.items]);
  const loadMoreFromScroll = useTableLoadMore(tableScrollRef, !!data && !open && more.hasMore && !more.loadingMore, more.loadMore);

  const rows = useMemo(() => sortMoverRows(buildMoverRows(movers), sort), [movers, sort]);
  const hasHistory = rows.some((row) => row.mover.change30d != null);
  const hasWeek = moversHaveWeekHistory(rows);
  const columns = useMemo(() => buildMoverColumns(width, hasHistory, hasWeek), [width, hasHistory, hasWeek]);
  const selectedIdx = Math.max(0, rows.findIndex((row) => row.key === selectedKey));
  const selected = rows[selectedIdx] ?? null;
  const openMover: CloudJobsMoverPayload | null = useMemo(
    () => (open ? (movers.find((mover) => mover.ticker === open) ?? null) : null),
    [open, movers],
  );
  const detailOpen = !!open;

  useShortcut((event) => {
    if (!focused) return;
    // With a company open, `r` belongs to that company's panel, once it is on screen.
    if (!(open && data) && handleRefreshKey(event, reload, { stopPropagation: true })) return;
    if (isPlainKey(event, "t")) {
      const ticker = open ?? selected?.ticker;
      if (!ticker) return;
      event.preventDefault?.();
      event.stopPropagation?.();
      navigateTicker(ticker);
    }
  });

  // Its own id: the open company's panel registers beside it, and unmounting
  // either must not take the other's hints with it.
  usePaneFooter(`${registrationId}:list`, () => ({
    info: detailOpen
      ? []
      : [
          ...(status === "loading" ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
          ...(more.loadingMore ? [{ id: "loading-more", parts: [{ text: "loading more companies", tone: "muted" as const }] }] : []),
          ...(error ? [{ id: "error", parts: [{ text: error.slice(0, 60), tone: "warning" as const }] }] : []),
        ],
    hints: open || selected
      ? [{ id: "ticker", key: "t", label: "icker", onPress: () => navigateTicker((open ?? selected?.ticker)!) }]
      : [],
  }), [status, more.loadingMore, error, data, detailOpen, open, selected, navigateTicker]);

  const renderCell = useCallback((row: MoverRow, column: MoverColumn): DataTableCell => {
    switch (column.id) {
      case "ticker":
        return { text: row.ticker, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "company":
        return { text: row.company, color: colors.text };
      case "open":
        return { text: row.open, color: colors.textBright };
      case "change":
        return { text: row.change, color: statToneColor(changeTone(row.changeValue), colors) };
      case "posted30d":
        return { text: row.posted30d, color: colors.text };
      case "new7d":
        return { text: row.new7d, color: colors.text };
      case "function":
        return { text: row.function, color: colors.textDim };
      case "country":
        return { text: row.country, color: colors.textDim };
    }
  }, []);

  if (status === "loading" && !data) return <PaneStatusBody loading align="center" loadingLabel="Loading hiring data..." />;
  if (status === "error" && !data) return <PaneStatusBody error={error ?? "Could not load hiring data."} errorTitle="Could not load hiring data." actions={<Button label="Try again" onPress={reload} />} />;

  const tableHeight = Math.max(3, height - (nativePaneChrome ? 1 : 0));
  return (
    <Box flexDirection="column" width={width} height={height}>
      <DataTableStackView<MoverRow, MoverColumn>
        focused={focused}
        scrollRef={tableScrollRef}
        onBodyScrollActivity={loadMoreFromScroll}
        detailOpen={detailOpen}
        onBack={() => setOpen(null)}
        detailTitle={openMover ? [openMover.ticker, openMover.companyName].filter(Boolean).join(" · ") : open ?? undefined}
        detailContent={open ? (
          <CompanyPanel
            symbol={open}
            companyName={openMover?.companyName ?? null}
            width={width}
            height={Math.max(4, height - 1)}
            focused={focused}
            registrationId={`${registrationId}:company`}
          />
        ) : null}
        selection={{ kind: "index", selectedIndex: rows.length ? selectedIdx : -1, onChange: (_index, row) => setSelectedKey(row.key) }}
        onActivate={(row) => setOpen(row.ticker)}
        rootWidth={width}
        rootHeight={tableHeight}
        columns={columns}
        freezeFirstColumn
        items={rows}
        sortColumnId={sort.columnId}
        sortDirection={sort.direction}
        onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as MoverColumnId, {
          firstDirection: columnId === "ticker" || columnId === "company" || columnId === "function" ? "asc" : "desc",
        }))}
        getItemKey={(row) => row.key}
        renderCell={renderCell}
        selectedTextOverridesCellColor
        emptyStateTitle={status === "loading" ? "Loading..." : "No companies covered yet"}
      />
    </Box>
  );
}

// Pane ----------------------------------------------------------------------

interface JobsViewProps {
  width: number;
  height: number;
  focused: boolean;
  /** The research tab always shows the company; the pane shows coverage when unbound. */
  companyOnly?: boolean;
}

function JobsView({ width, height, focused, companyOnly = false }: JobsViewProps) {
  const { ticker, symbol: boundSymbol } = usePaneTickerIdentity();
  const symbol = ticker?.metadata.ticker ?? null;
  const exchange = listingIdentity(boundSymbol, ticker?.metadata.exchange)?.exchange;
  const companyName = ticker?.metadata.name ?? null;
  const access = usePlanAccess();
  const registrationId = JOBS_PANE_ID;

  if (!access.signedIn) return <SignInWall placement="jobs-signin" width={width} height={height} symbol={symbol} exchange={exchange} action="see who is hiring" />;
  if (!access.emailVerified) return <SignInWall placement="jobs-signin" width={width} height={height} symbol={symbol} exchange={exchange} action="see who is hiring" needsVerification />;
  if (!access.hasProAccess) return <HiringProWall symbol={symbol} exchange={exchange} width={width} height={height} />;

  if (!symbol) {
    if (companyOnly) return <EmptyState title="No ticker selected." message="Select a ticker to see its hiring." />;
    return <HomeView width={width} height={height} focused={focused} registrationId={registrationId} />;
  }
  return (
    <CompanyPanel
      symbol={symbol}
      exchange={exchange}
      companyName={companyName}
      width={width}
      height={height}
      focused={focused}
      registrationId={registrationId}
      embedded={companyOnly}
    />
  );
}

export function JobsPane(props: { width: number; height: number; focused: boolean }) {
  return <JobsView {...props} />;
}

export function JobsResearchTab(props: { width: number; height: number; focused: boolean }) {
  return <JobsView {...props} companyOnly />;
}
