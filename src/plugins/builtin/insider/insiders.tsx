import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InsiderSignalSide } from "../../../api-client/insider-signals";
import {
  DataTableView,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
  type QueryBarView,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useUiCapabilities } from "../../../ui";
import { formatShortDate } from "../../../utils/datetime-format";
import { compareSortValues, nextHeaderSort, type SortDirection } from "../../../utils/sort-values";
import { SignInWall } from "../cloud/auth-actions";
import type { CloudResource } from "../shared/cloud-resource";
import { missingCell } from "../shared/research-cells";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { factCell } from "./signals-cells";
import {
  cachedInsiderCompany,
  DEFAULT_INSIDER_SIGNAL_WINDOW,
  loadInsiderCompany,
  type InsiderCompanyActivity,
  type InsiderCompanyQuery,
} from "./signals-client";
import {
  buildInsiderActivityColumns,
  formatSignalValue,
  INSIDER_SIGNAL_WINDOW_OPTIONS,
  insiderActivityDefaultSort,
  insiderActivityEmptyTitle,
  insiderActivityFirstDirection,
  insiderActivityKey,
  insiderActivityLines,
  insiderActivitySortValue,
  insiderSignalsCoverageNotice,
  type InsiderActivityColumn,
  type InsiderActivityColumnId,
  type InsiderActivityLine,
  type InsiderViewMode,
} from "./signals-model";

/**
 * What INS on a ticker shows and over which window, and whose dollars its
 * Insiders view sorts by first. A pane of its own keeps them as its pane
 * state; a company opened from the ranking gets them from the ranking, which
 * starts them where the ranking was.
 */
export interface InsiderViewControl {
  view: InsiderViewMode;
  setView: (view: InsiderViewMode) => void;
  /** Days the Insiders view covers. */
  window: number;
  setWindow: (window: number) => void;
  side: InsiderSignalSide;
}

/** The insiders' answer with the query it answers, so another window's rows are told from this one's. */
interface InsiderCompanyAnswer {
  query: InsiderCompanyQuery;
  resource: CloudResource<InsiderCompanyActivity>;
}

/**
 * INS on a ticker, its insiders: one row per insider over the window, in
 * the ranking's terms (their nth trade, size against usual, stake, the
 * dollars on the side their trades net to, the last day), read from the
 * server that scores the ranking, so an insider reads the same in both.
 * Enter on one shows their trades, as filed.
 */
export function InsiderActivityView({ symbol, control, viewBar, width, height, focused, onOpenInsider }: {
  /** The listing's symbol, as the server keys companies: BORR, BRK.B. */
  symbol: string;
  control: InsiderViewControl;
  viewBar: QueryBarView<InsiderViewMode>;
  width: number;
  height: number;
  focused: boolean;
  /** The insider's reported name, which the Trades view's Insider filter takes. */
  onOpenInsider: (reportedName: string) => void;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const session = useResearchCloudSession();
  const window = control.window;
  const query = useMemo<InsiderCompanyQuery>(() => ({ ticker: symbol, window }), [symbol, window]);
  const loader = useCallback(
    async (force: boolean): Promise<InsiderCompanyAnswer> => ({ query, resource: await loadInsiderCompany(query, { force }) }),
    [query],
  );
  const resource = useAsyncResource(loader, {
    initialData: () => {
      const cached = cachedInsiderCompany(query);
      return cached ? { query, resource: cached } : null;
    },
    clearOnError: (error) => error instanceof Error && isCloudSessionRequired(error.message),
    // Another window keeps the rows on screen, loading, until its own arrive.
    keepPreviousData: true,
  });
  const answered = resource.data?.query === query ? resource.data.resource : null;
  const shown = answered ?? (resource.loading ? resource.data?.resource ?? null : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  const sessionKeyRef = useRef(session.requestKey);
  const reload = resource.reload;
  useEffect(() => {
    if (sessionKeyRef.current === session.requestKey) return;
    sessionKeyRef.current = session.requestKey;
    void reload();
  }, [reload, session.requestKey]);

  const activity = shown?.payload ?? null;
  const lines = useMemo(() => (activity ? insiderActivityLines(activity) : []), [activity]);
  const [sort, setSort] = useState<{ columnId: InsiderActivityColumnId; direction: SortDirection }>(() => insiderActivityDefaultSort(control.side));
  const sortedLines = useMemo(() => {
    const order = new Map(lines.map((line, index) => [line, index]));
    return [...lines].sort((a, b) => (
      compareSortValues(insiderActivitySortValue(a, sort.columnId), insiderActivitySortValue(b, sort.columnId), sort.direction)
      || order.get(a)! - order.get(b)!
    ));
  }, [lines, sort]);
  const columns = useMemo(() => buildInsiderActivityColumns(width, lines), [lines, width]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  usePaneStatusFooter({
    registrationId: "insider:insiders",
    loading: resource.loading,
    error: activity ? resource.error : null,
    stale: !!activity && !!shown?.stale,
    info: activity?.buy.asOf
      ? [{ id: "asof", asOf: true, parts: [{ text: `as of ${formatShortDate(activity.buy.asOf, { utc: true })}`, tone: "muted" as const }] }]
      : [],
  });
  const notices = useMemo(() => {
    if (!activity) return [];
    const coverage = [activity.buy, activity.sell]
      .map((payload) => insiderSignalsCoverageNotice(payload, { subject: "this list" }))
      .filter((notice): notice is string => !!notice);
    return [...new Set([...coverage, ...(shown?.refreshError ? [shown.refreshError] : [])])];
  }, [activity, shown?.refreshError]);
  usePaneNoticeFooter({ registrationId: "insider:insiders:notices", focused, notices });

  const renderCell = (line: InsiderActivityLine, column: InsiderActivityColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    switch (column.id) {
      case "name": return { text: line.name, color: colors.text };
      case "role": return { text: line.role, color: colors.textMuted };
      // Each fact in its insider's own side's tone, as the ranking draws it.
      case "nth": return factCell(line.nth, line.side, colors, state.selected);
      case "usual": return factCell(line.usual, line.side, colors, state.selected);
      case "stake": return factCell(line.stake, line.side, colors, state.selected, nativePaneChrome ? undefined : column.width);
      case "bought": return line.bought == null ? missingCell(colors) : { text: formatSignalValue(line.bought), value: line.bought, color: colors.positive };
      case "sold": return line.sold == null ? missingCell(colors) : { text: formatSignalValue(line.sold), value: line.sold, color: colors.negative };
      case "last": return { text: line.last, value: line.buyer.lastBuy, color: colors.textDim };
    }
  };

  if (!activity && isCloudSessionRequired(resource.error)) {
    return <SignInWall placement="insider-insiders-signin" width={width} height={height} action="view insiders" needsVerification={session.needsVerification} />;
  }

  const queryBar = (
    <QueryBar
      width={width}
      filters={[{
        id: "window",
        label: "Window",
        title: "Days of insider buying and selling",
        value: String(window),
        defaultValue: String(DEFAULT_INSIDER_SIGNAL_WINDOW),
        options: INSIDER_SIGNAL_WINDOW_OPTIONS,
        inline: true,
        onChange: (value: string) => control.setWindow(Number(value)),
      }]}
      view={viewBar}
    />
  );
  if (!activity) {
    // Loading, or a failure: the bar stays above, so Trades and another window are one click away.
    return (
      <Box flexDirection="column" width={width} height={height}>
        {queryBar}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error}
          retry={{ onRetry: () => void resource.reload(), pending: resource.loading }}
          subject="Insiders"
        />
      </Box>
    );
  }

  return (
    <DataTableView<InsiderActivityLine, InsiderActivityColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={sortedLines}
      getItemKey={insiderActivityKey}
      selection={{
        kind: "id",
        selectedId: selectedKey,
        getId: insiderActivityKey,
        onChange: (key) => setSelectedKey(key),
      }}
      onActivate={(line) => onOpenInsider(line.buyer.name)}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as InsiderActivityColumnId, {
        firstDirection: insiderActivityFirstDirection,
      }))}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
      emptyStateTitle={insiderActivityEmptyTitle(window)}
      emptyStateHint="Trades lists every Form 4 the company's insiders filed."
    />
  );
}
