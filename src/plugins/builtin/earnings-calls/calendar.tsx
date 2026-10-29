import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CloudEarningsCallPayload } from "../../../api-client";
import { usePlanAccess } from "../../../api-client/plan-access";
import {
  buildSectionedRows,
  DataTableStackView,
  isSectionedItemRow,
  QueryBar,
  renderSectionedRowHeader,
  usePaneNoticeFooter,
  usePaneStatusFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type DataTableRootKeyContext,
  type PaneHint,
  type QueryBarView,
  type SectionedRow,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { savedCopyFooterInfo } from "../../../components/layout/pane/footer";
import { isPermanentClientError } from "../../../api-client/errors";
import { TABLE_COLUMN_GAP, tableColumnWidth } from "../../../components/ui/table-layout";
import { useAsyncResource } from "../../../react/async-resource";
import { useAgeClock, useAutoRefresh } from "../../../react/auto-refresh";
import { colors } from "../../../theme/colors";
import { TextAttributes } from "../../../ui";
import { isPlainArrowUp, stopSearchFocusNavigation } from "../../../utils/search-focus-navigation";
import { usePluginPaneState } from "../../runtime";
import { newYorkToday } from "../earnings/board-model";
import { ProWall, SignInWall } from "../cloud/auth-actions";
import { cachedUpcomingCalls, calendarAway, loadUpcomingCalls, statusOf, upcomingCutNotice, type UpcomingCallsResult } from "./data";
import { callPeriod } from "./format";
import {
  calendarDays,
  calendarSections,
  callLocalClock,
  callNewYorkClock,
  clockIsNewYork,
  DEFAULT_CALENDAR_SORT,
  isUpcomingCall,
  type CalendarSort,
} from "./upcoming";

export type CallsView = "upcoming" | "transcripts";

/** CALLS alone: the calendar of every company's calls, or the shelf of transcripts. */
export const CALLS_VIEWS: ReadonlyArray<{ value: CallsView; label: string }> = [
  { value: "upcoming", label: "Upcoming" },
  { value: "transcripts", label: "Transcripts" },
];

type CalendarColumnId = "ticker" | "company" | "local" | "newYork" | "period" | "away";
type CalendarColumn = DataTableColumn & { id: CalendarColumnId };
type CalendarRow = SectionedRow<CloudEarningsCallPayload>;

const COMPANY_MIN_WIDTH = 12;
const MISSING = "\u2014";

const ALL_COLUMNS: CalendarColumn[] = [
  { id: "ticker", label: "TICKER", width: 6, align: "left" },
  { id: "company", label: "COMPANY", width: COMPANY_MIN_WIDTH, align: "left" },
  { id: "local", label: "LOCAL", width: 5, align: "left" },
  { id: "newYork", label: "ET", width: 5, align: "left" },
  { id: "period", label: "PERIOD", width: 7, align: "left" },
  // "in 23h 59m" and "in progress" are the longest.
  { id: "away", label: "IN", width: 11, align: "right" },
];

/** Dropped first when narrow: the period, then the local clock (New York's stays). */
const DROP_ORDER: CalendarColumnId[] = ["period", "local"];

/** Header clicks sort these within each day; the rest keep start order. */
const SORTABLE: Partial<Record<CalendarColumnId, CalendarSort["column"]>> = {
  ticker: "ticker", company: "company", local: "time", newYork: "time",
};

function calendarColumns(width: number, { localClock }: { localClock: boolean }): CalendarColumn[] {
  const fixed = (list: CalendarColumn[]) =>
    list.reduce((sum, column) => sum + (column.id === "company" ? 0 : tableColumnWidth(column)) + TABLE_COLUMN_GAP, 2);
  let columns = localClock ? ALL_COLUMNS : ALL_COLUMNS.filter((column) => column.id !== "local");
  for (const id of DROP_ORDER) {
    if (fixed(columns) + COMPANY_MIN_WIDTH <= width) break;
    columns = columns.filter((column) => column.id !== id);
  }
  const companyWidth = Math.max(COMPANY_MIN_WIDTH, width - fixed(columns));
  return columns.map((column) => (column.id === "company" ? { ...column, width: companyWidth } : column));
}

function renderCalendarCell(row: CalendarRow, column: CalendarColumn, now: number): DataTableCell {
  if (!isSectionedItemRow(row)) return { text: "" };
  const call = row.item;
  // A call already over is shown and quieter, as a row that no longer applies is.
  const over = !isUpcomingCall(call, now);
  const tone = (color: string) => (over ? colors.textMuted : color);
  switch (column.id) {
    case "ticker":
      return { text: call.ticker, color: tone(colors.text), attributes: over ? undefined : TextAttributes.BOLD };
    case "company":
      return { text: call.companyName ?? call.ticker, color: tone(colors.text) };
    case "local": {
      const clock = callLocalClock(call);
      return clock ? { text: clock, color: tone(colors.text) } : { text: MISSING, color: colors.textMuted };
    }
    case "newYork": {
      const clock = callNewYorkClock(call);
      return clock ? { text: clock, color: tone(colors.textDim) } : { text: MISSING, color: colors.textMuted };
    }
    case "period":
      return { text: callPeriod(call), color: tone(colors.textDim) };
    case "away":
      return { text: calendarAway(call, now), color: over ? colors.textMuted : colors.textBright };
  }
}

function matches(call: CloudEarningsCallPayload, query: string): boolean {
  return `${call.ticker} ${call.companyName ?? ""}`.toLowerCase().includes(query);
}

interface CompanyCallsProps {
  ticker: string;
  focused: boolean;
  height: number;
  /** The company's view says when it holds Back, Esc and Backspace (a call open, its search focused). */
  onHoldsKeys: (holds: boolean) => void;
}

interface UpcomingCallsViewProps {
  focused: boolean;
  width: number;
  height: number;
  view: QueryBarView<CallsView>;
  /** A company's calls, opened from the calendar in its place. */
  renderCompany: (props: CompanyCallsProps) => ReactNode;
}

const NO_CALLS: CloudEarningsCallPayload[] = [];

/**
 * CALLS alone: every company's calls today, the next session and the rest of
 * that week, as ERN's board lays out its days. Enter opens the company's calls.
 */
export function UpcomingCallsView({ focused, width, height, view, renderCompany }: UpcomingCallsViewProps) {
  const access = usePlanAccess();
  const entitled = access.signedIn && access.emailVerified && access.hasProAccess;
  // The days move at New York's midnight; the countdowns on a coarse clock.
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const now = useAgeClock(loadedAt);
  const today = newYorkToday(new Date(now));
  const days = useMemo(() => calendarDays(Date.parse(`${today}T12:00:00-05:00`)), [today]);
  const range = useMemo(() => ({ from: days[0]!.from, to: days.at(-1)!.to }), [days]);

  const refusal = useRef<number | undefined>(undefined);
  const loader = useCallback(async (force: boolean): Promise<UpcomingCallsResult> => {
    try {
      const result = await loadUpcomingCalls(range, { force });
      refusal.current = result.errorStatus;
      return result;
    } catch (error) {
      refusal.current = statusOf(error);
      throw error;
    }
  }, [range]);
  const resource = useAsyncResource(entitled ? loader : null, {
    keepPreviousData: true,
    // A refusal asking again will not change takes the calendar off screen, for its wall or its error.
    clearOnError: isPermanentClientError,
    initialData: () => cachedUpcomingCalls(range),
  });
  const data = resource.data;
  useEffect(() => {
    if (data) setLoadedAt(data.fetchedAt);
  }, [data]);
  useAutoRefresh(resource.updatedAt, resource.load);

  const [openTicker, setOpenTicker] = usePluginPaneState<string | null>("calendar:open", null);
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("calendar:selected", null);
  const [sort, setSort] = useState<CalendarSort>(DEFAULT_CALENDAR_SORT);
  const [query, setQuery] = useState("");
  const { active: searchFocused, focus: focusSearch, blur: blurSearch, searchProps } = useQueryBarSearch();
  // The company's own view takes Back while a call is open in it or its search has the keys.
  const [companyHoldsKeys, setCompanyHoldsKeys] = useState(false);

  const calls = data?.calls ?? NO_CALLS;
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const shown = needle ? calls.filter((call) => matches(call, needle)) : calls;
    return buildSectionedRows(calendarSections(shown, days, sort), (call) => call.id);
  }, [calls, days, query, sort]);
  const callRows = useMemo(() => rows.filter(isSectionedItemRow), [rows]);
  // The cursor starts on the next call, so the day's calls already over sit above it.
  const selected = callRows.find((row) => row.key === selectedKey)
    ?? callRows.find((row) => isUpcomingCall(row.item, now))
    ?? callRows[0]
    ?? null;
  const localClock = useMemo(() => !clockIsNewYork(calls, now), [calls, now]);
  const columns = useMemo(() => calendarColumns(width, { localClock }), [localClock, width]);
  const renderCell = useCallback((row: CalendarRow, column: CalendarColumn) => renderCalendarCell(row, column, now), [now]);

  const openCall = openTicker ? calls.find((call) => call.ticker === openTicker) ?? null : null;
  const detailOpen = !!openTicker && entitled;
  const reload = useCallback(() => void resource.reload(), [resource.reload]);

  const refused = refusal.current;
  const signInRequired = !access.signedIn || (!data && refused === 401);
  const verificationRequired = !signInRequired && (!access.emailVerified || (!data && refused === 403));
  const proRequired = !signInRequired && !verificationRequired && (!access.hasProAccess || (!data && refused === 402));

  const hints = useMemo<PaneHint[]>(() => [{ id: "search", key: "/", label: "search", onPress: focusSearch }], [focusSearch]);
  // A refresh that failed shows the calendar an earlier read saved, and says when that copy is from.
  const savedAt = data?.savedAt ?? null;
  const savedInfo = useMemo(() => savedCopyFooterInfo([savedAt]), [savedAt]);
  usePaneStatusFooter({
    registrationId: "earnings-calls:calendar",
    enabled: !detailOpen && entitled,
    loading: resource.loading && !!data,
    error: data ? (savedAt == null ? data.refreshError : null) ?? resource.error : null,
    stale: !!data && savedAt == null && (data.stale || !!resource.error),
    info: savedInfo,
    hints,
  });
  // A calendar cut at the server's limit says so, rather than end the week early.
  usePaneNoticeFooter({
    registrationId: "earnings-calls:calendar-notices",
    focused,
    enabled: !detailOpen && entitled,
    notices: data?.truncated ? [upcomingCutNotice(data.calls)] : [],
  });

  const handleRootKey = useCallback((event: DataTableKeyEvent, context: DataTableRootKeyContext) => {
    if (context.selectedIndex <= 0 && isPlainArrowUp(event)) {
      stopSearchFocusNavigation(event);
      focusSearch();
      return true;
    }
    return handleRefreshKey(event, reload, { stopPropagation: true });
  }, [focusSearch, reload]);

  if (signInRequired || verificationRequired) {
    return (
      <SignInWall
        placement="calls-signin" width={width} height={height} symbol={null}
        action="browse earnings call transcripts" needsVerification={verificationRequired}
      />
    );
  }
  if (proRequired) {
    return (
      <ProWall
        placement="calls-wall" width={width} height={height} symbol={null}
        title="Earnings call transcripts are part of Gloom Cloud Pro."
        message="Every company's earnings calls this week with their start times, then each call's full transcript with speaker attribution, analyst Q&A, and extracted guidance, risks and tone."
      />
    );
  }

  const sortColumn = (Object.entries(SORTABLE).find(([id, value]) => value === sort.column && (id !== "local" || localClock))?.[0]) ?? null;
  return (
    <DataTableStackView<CalendarRow, CalendarColumn>
      focused={focused && !searchFocused && !companyHoldsKeys}
      detailOpen={detailOpen}
      onBack={() => setOpenTicker(null)}
      detailTitle={openTicker ? (openCall?.companyName ? `${openTicker} · ${openCall.companyName}` : openTicker) : undefined}
      detailContent={detailOpen && openTicker
        ? renderCompany({ ticker: openTicker, focused, height: Math.max(4, height - 1), onHoldsKeys: setCompanyHoldsKeys })
        : null}
      rootBefore={
        <QueryBar
          width={width}
          search={{
            value: query,
            onChange: setQuery,
            placeholder: "ticker or company",
            focused: focused && !detailOpen,
            ...searchProps,
            debounceMs: 80,
          }}
          view={view}
        />
      }
      status={data ? undefined : { loading: resource.loading, error: resource.error, subject: "the earnings call calendar" }}
      onRootKeyDown={handleRootKey}
      rootWidth={width}
      rootHeight={Math.max(2, height)}
      columns={columns}
      items={rows}
      getItemKey={(row) => row.key}
      isNavigable={isSectionedItemRow}
      renderSectionHeader={renderSectionedRowHeader}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      sortColumnId={sortColumn}
      sortDirection={sort.direction}
      onHeaderClick={(columnId) => {
        const column = SORTABLE[columnId as CalendarColumnId];
        if (!column) return;
        setSort((current) => current.column === column
          ? { column, direction: current.direction === "asc" ? "desc" : "asc" }
          : { column, direction: "asc" });
      }}
      selection={{
        kind: "index",
        selectedIndex: selected ? rows.indexOf(selected) : -1,
        onChange: (_index, row) => { if (isSectionedItemRow(row)) setSelectedKey(row.key); },
      }}
      onActivate={(row) => {
        if (!isSectionedItemRow(row)) return;
        blurSearch();
        setSelectedKey(row.key);
        setOpenTicker(row.item.ticker);
      }}
      resetScrollKey={`${range.from}:${query}`}
      emptyStateTitle={query.trim() ? "No matching calls." : "No calls on the calendar these days."}
      emptyStateHint={query.trim() ? "Clear the search to see every call." : undefined}
    />
  );
}
