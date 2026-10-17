import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InsiderSignalCap, InsiderSignalRoleGroup, InsiderSignalRow, InsiderSignalSide, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import {
  DataTableStackView,
  PaneStatusBody,
  QueryBar,
  usePaneFooter,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type DataTableCell,
  type QueryBarFilter,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, useUiCapabilities } from "../../../ui";
import { formatShortDate } from "../../../utils/datetime-format";
import { compareSortValues, nextHeaderSort } from "../../../utils/sort-values";
import { usePluginPaneState } from "../../runtime";
import { SignInWall } from "../cloud/auth-actions";
import type { CloudResource } from "../shared/cloud-resource";
import { listingCell, missingCell } from "../shared/research-cells";
import { isCloudSessionRequired, useResearchCloudSession } from "../shared/research-cloud-session";
import { cachedInsiderSignals, DEFAULT_INSIDER_SIGNAL_WINDOW, loadInsiderSignals, type InsiderSignalsQuery } from "./signals-client";
import {
  buildInsiderSignalColumns,
  formatSignalDay,
  formatSignalValue,
  INSIDER_SIGNAL_CAP_OPTIONS,
  INSIDER_SIGNAL_MIN_OPTIONS,
  INSIDER_SIGNAL_ROLE_OPTIONS,
  INSIDER_SIGNAL_SIDE_OPTIONS,
  INSIDER_SIGNAL_SIDE_SHORT,
  INSIDER_SIGNAL_WINDOW_OPTIONS,
  INSIDER_SIGNAL_NONE,
  insiderSideWords,
  insiderSignalOnly,
  insiderSignalOnlyOptions,
  insiderSignalDetailTitle,
  insiderSignalFirstDirection,
  insiderSignalsCoverageNotice,
  insiderSignalsEmptyTitle,
  insiderSignalsFiltered,
  insiderSignalsQueryFrom,
  insiderSignalsBarFit,
  insiderSignalRowFacts,
  insiderSignalSortValue,
  type InsiderSignalColumn,
  type InsiderSignalColumnId,
  type InsiderSignalOnly,
} from "./signals-model";
import { factCell } from "./signals-cells";
import { InsiderSignalCompanyDetail } from "./signals-detail";

interface InsiderSignalsViewProps {
  width: number;
  height: number;
  focused: boolean;
  /** Opens the company's own INS, its trades as filed, in its own pane. */
  onOpenIns: (ticker: string) => void;
}

/** A ranking with the query it answers, so rows another query left on screen are told from this one's. */
interface InsiderSignalsAnswer {
  query: InsiderSignalsQuery;
  resource: CloudResource<InsiderSignalsPayload>;
}

/**
 * INS without a ticker: the companies whose insiders bought, or sold, their
 * own shares in the open market lately, ranked, each with why as columns:
 * the lead insider's role, nth trade, size against usual and stake. Filters
 * narrow by role, size, clusters, new positions or whole stakes sold, and
 * market value. Enter or a click opens a company here, as other tables open
 * a row: its figures and its insiders in the same columns, and Back or Esc
 * returns to the same row. `i` opens the company's own INS, its trades as
 * filed, in its own pane, from the table or the opened company.
 */
export function InsiderSignalsView({ width, height, focused, onOpenIns }: InsiderSignalsViewProps) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  const session = useResearchCloudSession();
  // Each part of the query is its own pane state, so `gloomberb shot INS --side sell` and the CLI's options set them one by one.
  const [storedSide, setSide] = usePluginPaneState<InsiderSignalSide>("insider:signals:side", "buy");
  const [storedWindow, setWindow] = usePluginPaneState<number>("insider:signals:window", DEFAULT_INSIDER_SIGNAL_WINDOW);
  const [storedRole, setRole] = usePluginPaneState<InsiderSignalRoleGroup>("insider:signals:role", "all");
  const [storedMin, setMin] = usePluginPaneState<number>("insider:signals:minValue", 0);
  const [storedCluster, setCluster] = usePluginPaneState<boolean>("insider:signals:cluster", false);
  const [storedPosition, setPosition] = usePluginPaneState<boolean>("insider:signals:position", false);
  const [storedCap, setCap] = usePluginPaneState<InsiderSignalCap | "all">("insider:signals:cap", "all");
  const query = useMemo(() => insiderSignalsQueryFrom({
    side: storedSide,
    window: storedWindow,
    role: storedRole,
    minValue: storedMin,
    cluster: storedCluster,
    position: storedPosition,
    cap: storedCap,
  }), [storedCap, storedCluster, storedMin, storedPosition, storedRole, storedSide, storedWindow]);
  const side = query.side;
  const words = insiderSideWords(side);
  const [selectedTicker, setSelectedTicker] = usePluginPaneState<string | null>("insider:signals:selected", null);
  // The opened company, by ticker, with the selected row, so a reload or a shared layout lands on it.
  const [openTicker, setOpenTicker] = usePluginPaneState<string | null>("insider:signals:open", null);
  const [sort, setSort] = useState<{ columnId: InsiderSignalColumnId; direction: "asc" | "desc" }>({ columnId: "score", direction: "desc" });

  const loader = useCallback(
    async (force: boolean): Promise<InsiderSignalsAnswer> => ({ query, resource: await loadInsiderSignals(query, { force }) }),
    [query],
  );
  const resource = useAsyncResource(loader, {
    initialData: () => {
      const cached = cachedInsiderSignals(query);
      return cached ? { query, resource: cached } : null;
    },
    clearOnError: (error) => error instanceof Error && isCloudSessionRequired(error.message),
    // Another side, window or filter keeps the rows on screen, loading, until its own arrive.
    keepPreviousData: true,
  });
  // The rows another query left stay only while this one loads the first time: once it has
  // failed, the body says so with Retry, never another side's or filter's rows under this one.
  const [failedQuery, setFailedQuery] = useState<InsiderSignalsQuery | null>(null);
  const answered = resource.data?.query === query ? resource.data.resource : null;
  useEffect(() => {
    if (!answered && resource.error) setFailedQuery(query);
  }, [answered, query, resource.error]);
  const shown = answered ?? (resource.loading && failedQuery !== query ? resource.data?.resource ?? null : null);
  useAutoRefresh(resource.updatedAt, resource.load);
  usePaneRefreshKey(() => void resource.reload(), { focused });
  // Signing in or out reads the ranking again for the new session.
  const sessionKeyRef = useRef(session.requestKey);
  const reload = resource.reload;
  useEffect(() => {
    if (sessionKeyRef.current === session.requestKey) return;
    sessionKeyRef.current = session.requestKey;
    void reload();
  }, [reload, session.requestKey]);

  const data = shown?.payload ?? null;
  // Rows of the other side, kept on screen while this one loads, are drawn in their own side's words.
  const dataSide: InsiderSignalSide = data?.side ?? "buy";
  const rows = data?.rows ?? [];
  const sortedRows = useMemo(() => {
    const order = new Map(rows.map((row, index) => [row.ticker, index]));
    // The shared sort: a missing fact last either way, the ranking's order between equals.
    return [...rows].sort((a, b) => (
      compareSortValues(insiderSignalSortValue(a, sort.columnId), insiderSignalSortValue(b, sort.columnId), sort.direction)
      || order.get(a.ticker)! - order.get(b.ticker)!
    ));
  }, [rows, sort]);
  const columns = useMemo(() => buildInsiderSignalColumns(width, rows, { side: dataSide }), [dataSide, rows, width]);
  const openRow = openTicker ? rows.find((row) => row.ticker === openTicker) ?? null : null;
  const detailOpen = !!openRow;
  // A company this query no longer ranks closes, once the query has answered.
  useEffect(() => {
    if (openTicker && answered && !answered.payload.rows.some((row) => row.ticker === openTicker)) setOpenTicker(null);
  }, [answered, openTicker, setOpenTicker]);
  const selectedRow = sortedRows.find((row) => row.ticker === selectedTicker) ?? sortedRows[0] ?? null;
  const insTarget = openRow ?? selectedRow;
  usePaneFooter("insider:signals:ins", () => (insTarget ? {
    hints: [{ id: "insider-ins", key: "i", label: "ns", title: "Insider transactions (INS)", onPress: () => onOpenIns(insTarget.ticker) }],
  } : null), [insTarget, onOpenIns]);

  usePaneStatusFooter({
    registrationId: "insider:signals",
    loading: resource.loading,
    error: data ? resource.error : null,
    stale: !!data && !!shown?.stale,
    info: data?.asOf
      ? [{ id: "asof", asOf: true, parts: [{ text: `as of ${formatShortDate(data.asOf, { utc: true })}`, tone: "muted" as const }] }]
      : [],
  });
  const coverageNotice = data ? insiderSignalsCoverageNotice(data) : null;
  usePaneNoticeFooter({
    registrationId: "insider:signals:notices",
    focused,
    enabled: !detailOpen,
    notices: [
      ...(coverageNotice ? [coverageNotice] : []),
      ...(shown?.refreshError ? [shown.refreshError] : []),
    ],
  });

  const renderCell = useCallback((row: InsiderSignalRow, column: InsiderSignalColumn, _index: number, state: { selected: boolean }): DataTableCell => {
    switch (column.id) {
      case "ticker": return listingCell(row.ticker, colors, state.selected);
      case "company": return { text: row.company, color: colors.textMuted };
      case "score": return { text: String(row.score), value: row.score, color: colors.textBright };
      case "role": {
        const role = insiderSignalRowFacts(row).role;
        // Muted, as a role reads in INS's trades and the opened company's insiders.
        return role === INSIDER_SIGNAL_NONE ? missingCell(colors) : { text: role, color: colors.textMuted };
      }
      case "nth": return factCell(insiderSignalRowFacts(row).nth, dataSide, colors, state.selected);
      case "usual": return factCell(insiderSignalRowFacts(row).usual, dataSide, colors, state.selected);
      // The terminal sets content in the column's own cells; the desktop's cell aligns it.
      case "stake": return factCell(insiderSignalRowFacts(row).stake, dataSide, colors, state.selected, nativePaneChrome ? undefined : column.width);
      case "insiders": return { text: String(row.insiders), value: row.insiders, color: colors.text };
      // Every row is buying, or selling, drawn as INS draws a buy or a sale.
      case "value": return { text: formatSignalValue(row.value), value: row.value, color: dataSide === "sell" ? colors.negative : colors.positive };
      case "lastBuy": return { text: formatSignalDay(row.lastBuy), value: row.lastBuy, color: colors.textDim };
    }
  }, [colors, dataSide, nativePaneChrome]);

  if (!data && isCloudSessionRequired(resource.error)) {
    return <SignInWall placement="insider-signals-signin" width={width} height={height} action="view insider activity" needsVerification={session.needsVerification} />;
  }

  const capShown = data?.marketCaps === "stored" || query.cap !== null;
  // The bar folds as far as it must for every control, Cap and clear included, to fit its one row.
  const fit = insiderSignalsBarFit(width, query, { capShown, desktop: !!nativePaneChrome });
  const setOnly = (value: InsiderSignalOnly) => {
    setCluster(value === "cluster" || value === "both");
    setPosition(value === "position" || value === "both");
  };
  const filters: QueryBarFilter[] = [
    {
      id: "side",
      label: "Side",
      title: "Insider buying or selling",
      value: side,
      options: fit.side === "full"
        ? INSIDER_SIGNAL_SIDE_OPTIONS
        : INSIDER_SIGNAL_SIDE_OPTIONS.map((option) => ({ ...option, short: INSIDER_SIGNAL_SIDE_SHORT[option.value] })),
      inline: fit.side !== "menu",
      onChange: (value: InsiderSignalSide) => {
        if (value === side) return;
        setSide(value);
        // New positions and whole stakes sold are one stored switch; a side starts with it off.
        setPosition(false);
      },
    },
    {
      id: "window",
      label: "Window",
      title: `Days of ${words.activity} to rank`,
      value: String(query.window),
      defaultValue: String(DEFAULT_INSIDER_SIGNAL_WINDOW),
      options: INSIDER_SIGNAL_WINDOW_OPTIONS,
      inline: fit.windowInline,
      onChange: (value: string) => setWindow(Number(value)),
    },
    {
      id: "role",
      label: "Role",
      title: "Whose trades to rank",
      value: query.role,
      defaultValue: "all",
      options: INSIDER_SIGNAL_ROLE_OPTIONS,
      onChange: (value: InsiderSignalRoleGroup) => setRole(value),
    },
    {
      id: "min",
      label: "Min",
      title: `Least the insiders ${words.traded.toLowerCase()} in the window`,
      value: String(query.minValue),
      defaultValue: "0",
      options: INSIDER_SIGNAL_MIN_OPTIONS,
      onChange: (value: string) => setMin(Number(value)),
    },
    ...(fit.only
      ? [{
        id: "only",
        label: "Only",
        title: side === "sell" ? "Only clusters, or whole stakes sold" : "Only clusters, or new positions",
        value: insiderSignalOnly(query),
        defaultValue: "any",
        options: insiderSignalOnlyOptions(side),
        onChange: setOnly,
      } satisfies QueryBarFilter]
      : [
        { id: "cluster", kind: "toggle", label: "Cluster", value: query.cluster, onChange: setCluster } satisfies QueryBarFilter,
        { id: "position", kind: "toggle", label: words.position, value: query.position, onChange: setPosition } satisfies QueryBarFilter,
      ]),
    ...(capShown ? [{
      id: "cap",
      label: "Cap",
      title: "Market value",
      value: query.cap ?? "all",
      defaultValue: "all",
      options: INSIDER_SIGNAL_CAP_OPTIONS,
      onChange: (value: InsiderSignalCap | "all") => setCap(value),
    } satisfies QueryBarFilter] : []),
  ];

  const queryBar = <QueryBar width={width} filters={filters} />;
  if (!data) {
    // Loading, or a failure: the query bar stays above, so another side or filter is one click away.
    return (
      <Box flexDirection="column" width={width} height={height}>
        {queryBar}
        <PaneStatusBody
          loading={resource.loading}
          error={resource.error}
          retry={{ onRetry: () => void resource.reload(), pending: resource.loading }}
          subject="Insider activity"
        />
      </Box>
    );
  }

  return (
    <DataTableStackView<InsiderSignalRow, InsiderSignalColumn>
      focused={focused}
      detailOpen={detailOpen}
      onBack={() => setOpenTicker(null)}
      detailTitle={openRow ? insiderSignalDetailTitle(openRow) : undefined}
      detailContent={openRow
        ? <InsiderSignalCompanyDetail key={openRow.ticker} row={openRow} side={dataSide} window={data.window} width={width} focused={focused} />
        : null}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      columns={columns}
      items={sortedRows}
      getItemKey={(row) => row.ticker}
      selection={{
        kind: "id",
        selectedId: selectedTicker,
        getId: (row) => row.ticker,
        onChange: (ticker) => setSelectedTicker(ticker),
      }}
      onActivate={(row) => {
        setSelectedTicker(row.ticker);
        setOpenTicker(row.ticker);
      }}
      sortColumnId={sort.columnId}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => setSort((current) => nextHeaderSort(current, columnId as InsiderSignalColumnId, {
        firstDirection: insiderSignalFirstDirection,
      }))}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      showHorizontalScrollbar={false}
      emptyStateTitle={insiderSignalsEmptyTitle(data.window, dataSide, insiderSignalsFiltered(query))}
    />
  );
}
