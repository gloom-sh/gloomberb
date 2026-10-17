import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InsiderSignalCap, InsiderSignalRoleGroup, InsiderSignalRow, InsiderSignalSide, InsiderSignalsPayload } from "../../../api-client/insider-signals";
import {
  ColumnGrid,
  DataTableView,
  Divider,
  PaneStatusBody,
  QueryBar,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  type ColumnGridColumn,
  type DataTableCell,
  type QueryBarFilter,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource, useAutoRefresh } from "../../../public/react";
import { useThemeColors } from "../../../theme/theme-context";
import type { ThemeColors } from "../../../theme/colors";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { formatShortDate } from "../../../utils/datetime-format";
import { displayWidth } from "../../../utils/format";
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
  INSIDER_BOTH_WAYS_MARK,
  INSIDER_SIGNAL_NONE,
  insiderSideWords,
  insiderSignalOnly,
  insiderSignalOnlyOptions,
  insiderSignalDetailLines,
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
  type InsiderSignalFact,
  type InsiderSignalOnly,
} from "./signals-model";

interface InsiderSignalsViewProps {
  width: number;
  height: number;
  focused: boolean;
  /** Opens the company's insider transactions in this pane. */
  onOpen: (ticker: string) => void;
}

/** The selected company's insiders under the table, until the pane is too short to spare the rows. */
const DETAIL_MIN_PANE_HEIGHT = 16;
/** Insiders the detail lists, largest first; the ranking keeps up to ten. */
const DETAIL_MAX_INSIDERS = 5;
const DETAIL_GAP = 2;

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
 * market value. Enter or a double click opens the company's own INS in the
 * same pane; the selected company's insiders are listed under the table.
 */
export function InsiderSignalsView({ width, height, focused, onOpen }: InsiderSignalsViewProps) {
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
        return role === INSIDER_SIGNAL_NONE ? missingCell(colors) : { text: role, color: colors.text };
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

  const selectedRow = sortedRows.find((row) => row.ticker === selectedTicker) ?? sortedRows[0] ?? null;
  const detail = selectedRow && height >= DETAIL_MIN_PANE_HEIGHT
    ? <InsiderSignalDetail row={selectedRow} side={dataSide} width={width} />
    : undefined;

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
    <DataTableView<InsiderSignalRow, InsiderSignalColumn>
      focused={focused}
      rootWidth={width}
      rootHeight={height}
      rootBefore={queryBar}
      rootAfter={detail}
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
        onOpen(row.ticker);
        setSelectedTicker(row.ticker);
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

/**
 * A fact's colour, the roles the why chips had: the side's tone for a fact
 * the ranking counts, a holding's change in its sign's tone, NEW and EXITED
 * too; plain text for a figure it does not count; the research panes' muted
 * placeholder for the dash.
 */
function factColor(fact: InsiderSignalFact, side: InsiderSignalSide, colors: ThemeColors): string {
  if (fact.weight === "none") return colors.textMuted;
  if (fact.weight === "plain") return colors.text;
  return (fact.sign ?? (side === "sell" ? -1 : 1)) < 0 ? colors.negative : colors.positive;
}

/**
 * A fact as figures right-aligned in their cell: NEW and EXITED bold, a stake
 * counted on the net with the both-ways mark after it, muted. `width` sets it
 * in that many cells (the terminal's table); without it the content grows to
 * its track.
 */
function FactFigures({ fact, side, selected, width }: { fact: InsiderSignalFact; side: InsiderSignalSide; selected: boolean; width?: number }) {
  const colors = useThemeColors();
  const figure = fact.bothWays ? fact.text.slice(0, -(INSIDER_BOTH_WAYS_MARK.length + 1)) : fact.text;
  return (
    <Box flexDirection="row" height={1} overflow="hidden" justifyContent="flex-end" flexGrow={1} width={width}>
      <Text fg={selected ? colors.selectedText : factColor(fact, side, colors)} attributes={fact.weight === "strong" ? TextAttributes.BOLD : TextAttributes.NONE}>{figure}</Text>
      {fact.bothWays ? <Text fg={selected ? colors.selectedText : colors.textMuted}>{` ${INSIDER_BOTH_WAYS_MARK}`}</Text> : null}
    </Box>
  );
}

/** A fact's table cell: plain text in its colour, or the figures with the both-ways mark. */
function factCell(fact: InsiderSignalFact, side: InsiderSignalSide, colors: ThemeColors, selected: boolean, width?: number): DataTableCell {
  if (fact.weight === "none" && !fact.bothWays) return missingCell(colors);
  const cell: DataTableCell = {
    text: fact.text,
    value: fact.value,
    color: factColor(fact, side, colors),
    ...(fact.weight === "strong" ? { attributes: TextAttributes.BOLD } : {}),
  };
  return fact.bothWays ? { ...cell, content: <FactFigures fact={fact} side={side} selected={selected} width={width} /> } : cell;
}

/** Below this the detail's names read as stubs: the size against usual goes, then the nth trade, as in the table. */
const DETAIL_NAME_MIN = 12;

/**
 * The selected company's insiders, largest first, in the table's columns:
 * name, role, nth trade, size against usual, stake, dollars and last trade
 * day.
 */
function InsiderSignalDetail({ row, side, width }: { row: InsiderSignalRow; side: InsiderSignalSide; width: number }) {
  const colors = useThemeColors();
  const words = insiderSideWords(side);
  const lines = insiderSignalDetailLines(row).slice(0, DETAIL_MAX_INSIDERS);
  if (!lines.length) return null;
  const inner = Math.max(1, width - 2);
  const fit = (texts: string[], label: string) => Math.max(displayWidth(label), ...texts.map(displayWidth));
  const widths = {
    role: fit(lines.map((line) => line.role), "Role"),
    nth: fit(lines.map((line) => line.nth.text), "Nth"),
    usual: fit(lines.map((line) => line.usual.text), "Vs Usual"),
    stake: fit(lines.map((line) => line.stake.text), "Stake"),
    value: fit(lines.map((line) => line.value), words.traded),
    last: fit(lines.map((line) => line.last), "Last"),
  };
  const show = { usual: true, nth: true };
  const figures = () => widths.role + widths.stake + widths.value + widths.last + DETAIL_GAP * 4
    + (show.nth ? widths.nth + DETAIL_GAP : 0) + (show.usual ? widths.usual + DETAIL_GAP : 0);
  for (const drop of ["usual", "nth"] as const) {
    if (inner - figures() >= DETAIL_NAME_MIN) break;
    show[drop] = false;
  }
  // Names as wide as the longest, so the figures sit beside them; cut only when the pane is short of room.
  const name = Math.max(8, Math.min(fit(lines.map((line) => line.name), row.ticker), inner - figures()));
  const gridColumns: ColumnGridColumn[] = [
    { width: name },
    { width: widths.role, gapBefore: DETAIL_GAP },
    ...(show.nth ? [{ width: widths.nth, gapBefore: DETAIL_GAP, align: "right" as const }] : []),
    ...(show.usual ? [{ width: widths.usual, gapBefore: DETAIL_GAP, align: "right" as const }] : []),
    { width: widths.stake, gapBefore: DETAIL_GAP, align: "right" },
    { width: widths.value, gapBefore: DETAIL_GAP, align: "right" },
    { width: widths.last, gapBefore: DETAIL_GAP, align: "right" },
  ];
  const factText = (fact: InsiderSignalFact) => fact.weight === "strong" || fact.bothWays
    ? { content: <FactFigures fact={fact} side={side} selected={false} /> }
    : { text: fact.text, color: factColor(fact, side, colors) };
  return (
    <Box flexDirection="column" flexShrink={0}>
      <Divider />
      <Box paddingX={1} flexDirection="column">
        <ColumnGrid
          columns={gridColumns}
          width={inner}
          role="insider-signal-detail"
          rows={[
            [
              { text: row.ticker, color: colors.textBright },
              { text: "Role", color: colors.textDim },
              ...(show.nth ? [{ text: "Nth", color: colors.textDim }] : []),
              ...(show.usual ? [{ text: "Vs Usual", color: colors.textDim }] : []),
              { text: "Stake", color: colors.textDim },
              { text: words.traded, color: colors.textDim },
              { text: "Last", color: colors.textDim },
            ],
            ...lines.map((line) => [
              { text: line.name, color: colors.text },
              { text: line.role, color: colors.textMuted },
              ...(show.nth ? [factText(line.nth)] : []),
              ...(show.usual ? [factText(line.usual)] : []),
              factText(line.stake),
              { text: line.value, color: colors.text },
              { text: line.last, color: colors.textDim },
            ]),
          ]}
        />
      </Box>
    </Box>
  );
}
