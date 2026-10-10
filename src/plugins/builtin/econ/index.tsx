import { Box } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  QueryBar,
  usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { usePluginPaneState } from "../../runtime";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneVisible } from "../../../state/app/activity";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors, blendHex } from "../../../theme/colors";
import type { EconEvent } from "./types";
import { EconDetailView } from "./detail-view";
import {
  COUNTRY_CYCLE,
  FILTER_CYCLE,
  attachEconCalendarPersistence,
  actualColor,
  calendarDisplayRows,
  CALENDAR_TIME_ZONE_LABEL,
  dateKey,
  dayLabel,
  formatCountdown,
  formatStaleness,
  getCalendarCache,
  impactIndicator,
  loadCalendar,
  matchesCountry,
  matchesImpact,
  resetEconCalendarPersistence,
  shortCalendarEnd,
  shortDayLabel,
  timeLabel,
  type CountryFilter,
  type DisplayRow,
  type EconCalendarColumn,
  type EconCalendarLoadResult,
  type ImpactFilter,
} from "./calendar-model";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { tableColumnWidth } from "../../../components/ui/table-layout";
import { useRemoteUiNode } from "../../../remote/semantic-tree";

const IMPACT_LABELS: Record<ImpactFilter, string> = {
  all: "All",
  high: "High",
  medium: "Med",
  low: "Low",
};

const NO_EVENTS: EconEvent[] = [];
/** A result says whether a forced reload asked for it, so its answer can reset the cursor. */
type CalendarResult = EconCalendarLoadResult & { forced?: boolean };
const loadEvents = async (force: boolean): Promise<CalendarResult> => ({ ...await loadCalendar(force), forced: force });
const cachedEvents = () => getCalendarCache();

function EconCalendarPane({ focused, width, height }: PaneProps) {
  // loadCalendar serves a fresh cache without a request, so the pane can always
  // ask and still follow the global cadence once the cache goes stale.
  const calendar = useAsyncResource<CalendarResult>(loadEvents, { initialData: cachedEvents });
  const { loading } = calendar;
  const events = calendar.data?.data ?? NO_EVENTS;
  const stale = calendar.data?.stale ?? false;
  const fetchedAt = calendar.data?.fetchedAt ?? null;
  // A cache that could not be refreshed arrives as a result, not a failure.
  const error = calendar.error ?? (loading ? null : calendar.data?.refreshError ?? null);
  // The selected row and the open event are remembered by event id, so a
  // reload or a shared layout comes back to the same release.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const [impactFilter, setImpactFilter] = usePluginPaneState<ImpactFilter>("impactFilter", "all");
  const [countryFilter, setCountryFilter] = usePluginPaneState<CountryFilter>("countryFilter", "all");
  const [now, setNow] = useState(Date.now());
  const [openKey, setOpenKey] = usePluginPaneState<string | null>("openKey", null);

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);

  useAutoRefresh(stale ? null : fetchedAt, calendar.load);

  // Tick every 30s to update staleness + countdown, only while the pane can be seen.
  const paneVisible = usePaneVisible();
  useEffect(() => {
    if (!paneVisible) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, [paneVisible]);

  const filtered = useMemo(() => events
    .filter((ev) => matchesImpact(ev, impactFilter) && matchesCountry(ev, countryFilter))
    .sort((a, b) => a.date.getTime() - b.date.getTime()),
  [countryFilter, events, impactFilter]);
  const detailEvent = useMemo(
    () => (openKey ? events.find((ev) => ev.id === openKey) ?? null : null),
    [events, openKey],
  );

  // Day headers and the NOW marker between the past and the upcoming events.
  const today = new Date(now);
  const rows = calendarDisplayRows(filtered, now);
  // Rows group by UTC day, so today starts at UTC midnight.
  const todayStart = Math.floor(now / 86_400_000) * 86_400_000;
  // A calendar that stops short of a week ahead says where it stops.
  const listedEnd = shortCalendarEnd(events, todayStart);
  const listedAfter = listedEnd ? `No events listed after ${shortDayLabel(listedEnd)}` : null;

  // Map from eventIdx to flat row index (for scroll tracking)
  const eventIdxToRowIdx = new Map<number, number>();
  let nowRowIdx = -1;
  let nextUpcomingEventIdx = -1;
  let nextUpcomingTime = Number.POSITIVE_INFINITY;
  // The first row of today or later, with the day header and NOW band above it.
  let todayRowIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.kind === "event") {
      eventIdxToRowIdx.set(row.eventIdx, r);
      const eventTime = row.event.date.getTime();
      if (todayRowIdx < 0 && eventTime >= todayStart) {
        todayRowIdx = r;
        while (todayRowIdx > 0 && rows[todayRowIdx - 1]!.kind !== "event") todayRowIdx -= 1;
      }
      if (eventTime > now && eventTime < nextUpcomingTime) {
        nextUpcomingEventIdx = row.eventIdx;
        nextUpcomingTime = eventTime;
      }
    } else if (row.kind === "now") {
      nowRowIdx = r;
    }
  }
  // Without a remembered row the pane sits at the present: the next release,
  // or the latest one once the week's releases are all out.
  const rememberedIdx = filtered.findIndex((ev) => ev.id === selectedKey);
  const selectedIdx = rememberedIdx >= 0 ? rememberedIdx
    : nextUpcomingEventIdx >= 0 ? nextUpcomingEventIdx : Math.max(0, filtered.length - 1);

  // The present at the top of the table: NOW a few rows down for context, but
  // never above today, so a Saturday opens on NOW and Monday rather than on
  // Friday's last releases. Asked for on open, on a filter change and on a
  // forced reload; it holds until the user scrolls or moves the selection.
  const presentRowIdx = nowRowIdx >= 0 ? Math.max(0, todayRowIdx, nowRowIdx - 3) : -1;
  const [presentRequest, setPresentRequest] = useState(1);
  const [presentAnchor, setPresentAnchor] = useState<{ index: number; version: number } | null>(null);
  const servedPresentRequest = useRef(0);
  useEffect(() => {
    if (servedPresentRequest.current === presentRequest || filtered.length === 0) return;
    // On open the selection moves to the next release as well.
    if (servedPresentRequest.current === 0 && nextUpcomingEventIdx >= 0) {
      setSelectedKey(filtered[nextUpcomingEventIdx]?.id ?? null);
    }
    servedPresentRequest.current = presentRequest;
    setPresentAnchor(presentRowIdx >= 0 ? { index: presentRowIdx, version: presentRequest } : null);
  }, [filtered.length, presentRequest]);
  const returnToPresent = useCallback(() => setPresentRequest((request) => request + 1), []);
  const leavePresent = useCallback(() => setPresentAnchor(null), []);

  const selectImpactFilter = useCallback((value: ImpactFilter) => {
    setImpactFilter(value);
    setSelectedKey(null);
    returnToPresent();
  }, [returnToPresent, setImpactFilter, setSelectedKey]);
  const selectCountryFilter = useCallback((value: CountryFilter) => {
    setCountryFilter(value);
    setSelectedKey(null);
    returnToPresent();
  }, [returnToPresent, setCountryFilter, setSelectedKey]);
  const cycleImpactFilter = useCallback((step: 1 | -1) => {
    setImpactFilter((prev) => FILTER_CYCLE[(FILTER_CYCLE.indexOf(prev) + step + FILTER_CYCLE.length) % FILTER_CYCLE.length]!);
    setSelectedKey(null);
    returnToPresent();
  }, [returnToPresent, setImpactFilter, setSelectedKey]);
  const cycleCountryFilter = useCallback((step: 1 | -1) => {
    setCountryFilter((prev) => COUNTRY_CYCLE[(COUNTRY_CYCLE.indexOf(prev) + step + COUNTRY_CYCLE.length) % COUNTRY_CYCLE.length]!);
    setSelectedKey(null);
    returnToPresent();
  }, [returnToPresent, setCountryFilter, setSelectedKey]);

  // A forced reload goes back to the present once it answers.
  const forcedResult = calendar.data?.forced ? calendar.data : null;
  useEffect(() => {
    if (!forcedResult) return;
    setSelectedKey(null);
    returnToPresent();
  }, [forcedResult, returnToPresent, setSelectedKey]);

  const handleRootKeyDown = useCallback((event: DataTableKeyEvent) => (
    handleRefreshKey(event, () => void calendar.reload(), { stopPropagation: true })
  ), [calendar.reload]);

  const columns = useMemo<EconCalendarColumn[]>(() => {
    // The header names the zone, so the column is as wide as the header needs.
    const timeLabelText = `TIME (${CALENDAR_TIME_ZONE_LABEL})`;
    const timeWidth = tableColumnWidth({ width: 6, label: timeLabelText });
    const impactWidth = 4;
    const flagWidth = 3;
    const actualWidth = 9;
    const forecastWidth = 10;
    const priorWidth = 9;
    const minEventWidth = 12;
    const fixedWidth = timeWidth + impactWidth + flagWidth + actualWidth + forecastWidth + priorWidth;
    // Padding, one gap per column boundary, and the vertical scrollbar lane;
    // one column short of that clipped the PRIOR values at the right edge.
    const columnCount = 7;
    const eventWidth = Math.max(minEventWidth, width - 3 - columnCount - fixedWidth);

    return [
      { id: "time", label: timeLabelText, width: timeWidth, align: "left" },
      { id: "impact", label: "IMP", width: impactWidth, align: "left" },
      { id: "country", label: "CTY", width: flagWidth, align: "left" },
      { id: "event", label: "EVENT", width: eventWidth, align: "left" },
      { id: "actual", label: "ACTUAL", width: actualWidth, align: "right" },
      { id: "forecast", label: "FORECAST", width: forecastWidth, align: "right" },
      { id: "prior", label: "PRIOR", width: priorWidth, align: "right" },
    ];
  }, [width]);
  const separatorBg = blendHex(colors.bg, colors.border, 0.3);
  const staleness = fetchedAt ? formatStaleness(fetchedAt, now) : "";
  const emptyStateHint = !loading && !error
    ? [
        impactFilter !== "all" ? `impact: ${impactFilter}` : null,
        countryFilter !== "all" ? `country: ${countryFilter}` : null,
      ].filter(Boolean).join(" · ") || undefined
    : undefined;

  // Next upcoming event for countdown
  const nextEvent = nextUpcomingEventIdx >= 0 ? filtered[nextUpcomingEventIdx] : undefined;
  const nextCountdown = nextEvent ? formatCountdown(nextEvent.date.getTime() - now) : null;
  // The countdown changes every tick, so it is footer status, not query bar
  // context; the footer ellipsizes a long event name.
  const nextText = nextEvent && nextCountdown ? `next ${nextEvent.event} ${nextCountdown}` : null;
  // The cached first paint is being replaced; its age only counts once a load has answered.
  const showStale = stale && (!loading || calendar.updatedAt !== null);
  // An empty list says it in its empty state instead.
  const listedAfterStatus = listedAfter && !detailEvent && filtered.length > 0 ? listedAfter : null;
  const calendarStatus = useMemo<PaneFooterSegment[]>(() => [
    ...(nextText && !detailEvent ? [{ id: "next", parts: [{ text: nextText, tone: "muted" as const }] }] : []),
    ...(listedAfterStatus ? [{ id: "listed-after", parts: [{ text: listedAfterStatus, tone: "warning" as const }] }] : []),
    ...(showStale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(staleness ? [{ id: "updated", parts: [{ text: staleness, tone: "muted" as const }] }] : []),
  ], [detailEvent, listedAfterStatus, nextText, showStale, staleness]);
  // A report of the pane (`gloomberb fn ECO`) says it too.
  const listedThrough = listedEnd ? dateKey(listedEnd) : null;
  useRemoteUiNode(listedAfter && listedThrough ? {
    role: "report-notice",
    label: "Listed through",
    getMetadata: () => ({ text: listedAfter, key: "listedThrough", value: listedThrough }),
  } : null);
  usePaneStatusFooter({
    registrationId: "econ-calendar",
    loading,
    error,
    info: calendarStatus,
  });
  // The filter keys step through the choices; Shift steps back. The pane menu
  // also offers each filter as a direct choice.
  const listOpen = !detailEvent;
  usePaneFooter("econ-calendar:filters", () => listOpen ? {
    hints: [
      { id: "impact", key: "f", label: " impact", title: "Next Impact", onPress: () => cycleImpactFilter(1) },
      { id: "region", key: "c", label: " region", title: "Next Region", onPress: () => cycleCountryFilter(1) },
    ],
    keys: [
      { id: "impact-back", key: "Shift+F", label: "", onPress: () => cycleImpactFilter(-1) },
      { id: "region-back", key: "Shift+C", label: "", onPress: () => cycleCountryFilter(-1) },
    ],
  } : null, [cycleCountryFilter, cycleImpactFilter, listOpen]);

  const openDisplayRow = useCallback((row: DisplayRow) => {
    if (row.kind !== "event") return;
    setOpenKey(row.event.id);
  }, [setOpenKey]);
  const renderSectionHeader = useCallback((row: DisplayRow) => {
    if (row.kind === "separator") {
      return {
        text: row.label,
        backgroundColor: separatorBg,
        color: colors.textBright,
        attributes: TextAttributes.BOLD,
      };
    }
    if (row.kind === "now") {
      // A filled band instead of repeated rule characters, so the desktop
      // webview paints a real background rather than terminal glyphs.
      return {
        text: " NOW ",
        color: colors.warning,
        backgroundColor: blendHex(colors.bg, colors.warning, 0.22),
        attributes: TextAttributes.BOLD,
      };
    }
    return null;
  }, [separatorBg]);
  const renderCell = useCallback((
    row: DisplayRow,
    column: EconCalendarColumn,
  ): DataTableCell => {
    if (row.kind !== "event") return { text: "" };

    const ev = row.event;
    switch (column.id) {
      case "time":
        return { text: timeLabel(ev.date), color: colors.textMuted };
      case "impact": {
        const indicator = impactIndicator(ev.impact);
        return {
          text: indicator.text,
          color: indicator.color,
        };
      }
      case "country":
        // The ISO code, not a flag emoji: emoji widths do not match a fixed
        // column and pushed the right-hand columns off the pane.
        return { text: ev.country, color: colors.textMuted };
      case "event":
        return { text: ev.event, color: colors.text };
      case "actual":
        return {
          text: ev.actual ?? "—",
          color: actualColor(ev.actual, ev.forecast),
        };
      case "forecast":
        return { text: ev.forecast ?? "—", color: colors.textDim };
      case "prior":
        return { text: ev.prior ?? "—", color: colors.textDim };
    }
  }, []);

  const selectedEvent = filtered[selectedIdx];
  const filterControls = (
    <QueryBar
      width={width}
      filters={[
        { id: "impact", label: "Impact", inline: true, value: impactFilter, defaultValue: "all",
          options: FILTER_CYCLE.map((value) => ({ value, label: IMPACT_LABELS[value] })),
          onChange: (value: string) => selectImpactFilter(value as ImpactFilter) },
        { id: "region", label: "Region", inline: true, value: countryFilter, defaultValue: "all",
          options: COUNTRY_CYCLE.map((value) => ({ value, label: value === "all" ? "All" : value })),
          onChange: (value: string) => selectCountryFilter(value as CountryFilter) },
      ]}
      meta={selectedEvent ? dayLabel(selectedEvent.date, today) : undefined}
    />
  );

  const detailContent = detailEvent ? (
    <EconDetailView
      event={detailEvent}
      width={width}
      height={Math.max(height - 1, 1)}
      focused={focused}
    />
  ) : (
    <Box flexGrow={1} />
  );

  return (
    <DataTableStackView<DisplayRow, EconCalendarColumn>
      focused={focused}
      detailOpen={!!detailEvent}
      onBack={() => setOpenKey(null)}
      detailTitle={detailEvent?.event}
      detailContent={detailContent}
      rootWidth={width}
      rootHeight={Math.max(1, height - 1)}
      rootBefore={filterControls}
      onRootKeyDown={handleRootKeyDown}
      selection={{
        kind: "index",
        selectedIndex: eventIdxToRowIdx.get(selectedIdx) ?? selectedIdx,
        onChange: (_index, row) => {
          leavePresent();
          if (row.kind === "event") setSelectedKey(row.event.id);
        },
      }}
      scrollToIndex={presentAnchor?.index}
      scrollToIndexAlign={presentAnchor ? "start" : "nearest"}
      scrollToIndexVersion={presentAnchor?.version ?? 0}
      onBodyScrollActivity={(source) => {
        if (source === "user") leavePresent();
      }}
      columns={columns}
      items={rows}
      isNavigable={(row) => row.kind === "event"}
      sortColumnId={null}
      sortDirection="asc"
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      getItemKey={(row) => row.key}
      onActivate={openDisplayRow}
      renderSectionHeader={renderSectionHeader}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={loading ? "Loading economic events..." : listedAfter ?? "No events"}
      emptyStateHint={emptyStateHint}
      showHorizontalScrollbar={false}
    />
  );
}

export const economicCalendarModule: PluginModule = {
  panes: [{
    id: "econ-calendar",
    reportFreshness: { status: "not-a-feed", basis: "calendar" },
    name: "Economic Calendar",
    icon: "E",
    component: EconCalendarPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 100, height: 30 },
    tableExport: true,
  }],
  paneTemplates: [{
    id: "econ-calendar-pane",
    paneId: "econ-calendar",
    label: "Economic Calendar",
    description: "Upcoming economic events, releases, and indicators.",
    // "econ" stays a keyword so the old ECON prefix still finds this pane.
    keywords: ["econ", "economic", "calendar", "events", "macro", "releases", "fed", "cpi", "gdp"],
    shortcut: { prefix: "ECO" },
  }],
  setup(ctx) {
    attachEconCalendarPersistence(ctx.persistence);
  },
  dispose() {
    resetEconCalendarPersistence();
  },
};
