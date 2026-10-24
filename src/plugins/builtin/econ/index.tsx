import { Box, useUiCapabilities } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { COUNTRY_FLAG_CELLS, withCountryFlag } from "../../../components/ui/country-flag";
import {
  Button,
  DataTableStackView,
  EmptyState,
  QueryBar,
  usePaneFooter,
  type DataTableCell,
  type DataTableKeyEvent,
  type PaneFooterSegment,
} from "../../../components";
import { usePluginPaneState } from "../../runtime";
import { useAppConfig, usePaneSettingValue } from "../../../public/react";
import { readerTimeZone, timeZoneCity, zonedClock } from "../../../utils/utc-time";
import { usePaneInstance } from "../../../state/app/context";
import { commandRequestParams } from "../shared/command-tab";
import { useAsyncResource } from "../../../react/async-resource";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneVisible } from "../../../state/app/activity";
import { formatCountdown } from "../../../utils/datetime-format";
import type { PaneProps } from "../../../types/plugin";
import type { PluginModule } from "../plugin-module";
import { colors, blendHex } from "../../../theme/colors";
import { hasNoStatedTime, type EconEvent } from "./types";
import { FRED_CATALOG_SERIES } from "./fred-catalog";
import { ECON_PRINT_NOTIFICATIONS_ENABLED_KEY, retainVisiblePrintRefresh, setupHighImpactPrintNotifications } from "./print-watch";
import { EconDetailView } from "./detail-view";
import {
  COUNTRY_CYCLE,
  COUNTRY_FILTER_HINT,
  countriesWithoutEvents,
  DEFAULT_IMPACT_FILTER,
  FILTER_CYCLE,
  attachEconCalendarPersistence,
  actualColor,
  calendarDisplayRows,
  CALENDAR_TIME_ZONE_LABEL,
  dateKey,
  dayLabel,
  filteredEmptyTitle,
  formatStaleness,
  getCalendarCache,
  subscribeCalendar,
  impactIndicator,
  loadCalendar,
  eventCountry,
  matchesCountry,
  matchesImpact,
  noScheduledReleasesMessage,
  parseCountryFilter,
  resetEconCalendarPersistence,
  shortCalendarEnd,
  shortDayLabel,
  timeLabel,
  valueColumnWidth,
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
const SPELLED_IMPACT = "IMPACT";
const SPELLED_COUNTRY = "COUNTRY";
/** Event names this wide still read; past it the headers spell themselves out. */
const SPELLED_HEADER_MIN_EVENT_WIDTH = 24;
/** A result says whether a forced reload asked for it, so its answer can reset the cursor. */
type CalendarResult = EconCalendarLoadResult & { forced?: boolean };
const loadEvents = async (force: boolean): Promise<CalendarResult> => ({ ...await loadCalendar(force), forced: force });
const cachedEvents = () => getCalendarCache();

function EconCalendarPane({ focused, width, height }: PaneProps) {
  // loadCalendar serves a fresh cache without a request, so the pane can always
  // ask and still follow the global cadence once the cache goes stale.
  const calendar = useAsyncResource<CalendarResult>(loadEvents, { initialData: cachedEvents });
  // A load made elsewhere, such as the print watch asking while a release is
  // due, reaches the open pane through the cache; the newer of the two wins.
  const [cacheVersion, setCacheVersion] = useState(0);
  useEffect(() => subscribeCalendar(() => setCacheVersion((version) => version + 1)), []);
  const cached = useMemo(() => getCalendarCache(), [cacheVersion]);
  const shown = cached && (!calendar.data || cached.fetchedAt > calendar.data.fetchedAt) ? cached : calendar.data;
  const { loading } = calendar;
  const events = shown?.data ?? NO_EVENTS;
  const stale = shown?.stale ?? false;
  const fetchedAt = shown?.fetchedAt ?? null;
  // A cache that could not be refreshed arrives as a result, not a failure.
  const error = calendar.error ?? (loading ? null : calendar.data?.refreshError ?? null);
  // The selected row and the open event are remembered by event id, so a
  // reload or a shared layout comes back to the same release.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const [impactFilter, setImpactFilter] = usePluginPaneState<ImpactFilter>("impactFilter", DEFAULT_IMPACT_FILTER);
  const [chosenCountry, setCountryFilter] = usePluginPaneState<CountryFilter>("countryFilter", "all");
  // Countries a caller named (`ECO MX,BR`, `fn ECO --country MX`) are shown once per request; a later choice is the reader's.
  const pane = usePaneInstance();
  const [countrySetting] = usePaneSettingValue<string>("country", "");
  const requestedCountry = pane?.params?.country || countrySetting || null;
  const countryRequest = pane?.params?.country ? `${pane.params.country}|${pane.params.tabAt ?? ""}`
    : countrySetting ? `setting|${countrySetting}` : "";
  const [shownCountryRequest, setShownCountryRequest] = usePluginPaneState("countryRequest", "");
  const countryPending = !!countryRequest && countryRequest !== shownCountryRequest;
  const countryFilter: CountryFilter = countryPending && requestedCountry ? requestedCountry : chosenCountry;
  useEffect(() => {
    if (!countryPending || !requestedCountry) return;
    setShownCountryRequest(countryRequest);
    setCountryFilter(requestedCountry);
  }, [countryPending, countryRequest, requestedCountry, setCountryFilter, setShownCountryRequest]);
  const [now, setNow] = useState(Date.now());
  const [openKey, setOpenKey] = usePluginPaneState<string | null>("openKey", null);

  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);

  useAutoRefresh(stale ? null : fetchedAt, calendar.load);

  const paneVisible = usePaneVisible();
  // In view, a due high-impact print is asked for on the print watch's timing
  // and lands here through the cache; a covered or hidden pane asks nothing.
  useEffect(() => (paneVisible ? retainVisiblePrintRefresh() : undefined), [paneVisible]);
  // Tick every 30s to update staleness + countdown, only while the pane can be seen.
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
  const showAllEvents = useCallback(() => {
    setImpactFilter("all");
    setCountryFilter("all");
    setSelectedKey(null);
    returnToPresent();
  }, [returnToPresent, setCountryFilter, setImpactFilter, setSelectedKey]);
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

  // The desktop and the web lead each country's code with its flag.
  const flagged = useUiCapabilities().nativePaneChrome === true;
  // A reader who set a time zone (`config set timezone`) gets their clock in a column beside UTC.
  const readerZone = readerTimeZone(useAppConfig().timezone);
  const columns = useMemo<EconCalendarColumn[]>(() => {
    // The header names the zone, so the column is as wide as the header needs.
    const timeLabelText = `TIME (${CALENDAR_TIME_ZONE_LABEL})`;
    const timeWidth = tableColumnWidth({ width: 6, label: timeLabelText });
    const actualWidth = valueColumnWidth(filtered, "actual", 9);
    const forecastWidth = valueColumnWidth(filtered, "forecast", 10);
    const priorWidth = valueColumnWidth(filtered, "prior", 9);
    const minEventWidth = 12;
    // The reader's clock, with the weekday on rows where it is another day than the UTC one they are listed under.
    const readerLabel = readerZone ? timeZoneCity(readerZone).toUpperCase() : null;
    const readerWidth = !readerZone || !readerLabel ? 0 : tableColumnWidth({ label: readerLabel,
      width: filtered.some((ev) => !hasNoStatedTime(ev) && zonedClock(ev.date.getTime(), readerZone).label.length > 5) ? 9 : 5 });
    // Padding, one gap per column boundary, and the vertical scrollbar lane;
    // one column short of that clipped the PRIOR values at the right edge.
    const roomBeside = (count: number, timesWidth: number) => (impactWidth: number, countryWidth: number) => (
      width - 3 - count - (timesWidth + impactWidth + countryWidth + actualWidth + forecastWidth + priorWidth)
    );
    const codeWidth = 2 + (flagged ? COUNTRY_FLAG_CELLS : 0);
    // The reader's column only where the event names keep room to read beside it, under the short headers.
    const withReader = readerWidth > 0 && roomBeside(8, timeWidth + readerWidth)(4, Math.max(3, codeWidth)) >= minEventWidth;
    const eventRoom = withReader ? roomBeside(8, timeWidth + readerWidth) : roomBeside(7, timeWidth);
    // IMPACT and COUNTRY in words while event names keep room to read; the
    // short labels otherwise, with the word on hover where there is one.
    const spelledImpactWidth = tableColumnWidth({ width: 1, label: SPELLED_IMPACT });
    const spelledCountryWidth = Math.max(codeWidth, tableColumnWidth({ width: 1, label: SPELLED_COUNTRY }));
    const spelled = eventRoom(spelledImpactWidth, spelledCountryWidth) >= SPELLED_HEADER_MIN_EVENT_WIDTH;
    const impactColumn = spelled
      ? { label: SPELLED_IMPACT, width: spelledImpactWidth }
      : { label: "IMP", width: 4, title: "Impact" };
    const countryColumn = spelled
      ? { label: SPELLED_COUNTRY, width: spelledCountryWidth }
      : { label: "CTY", width: Math.max(3, codeWidth), title: "Country" };
    const eventWidth = Math.max(minEventWidth, eventRoom(impactColumn.width, countryColumn.width));

    return [
      { id: "time", label: timeLabelText, width: timeWidth, align: "left" },
      ...withReader ? [{ id: "readerTime" as const, label: readerLabel!, width: readerWidth, align: "left" as const, title: readerZone! }] : [],
      { id: "impact", ...impactColumn, align: "left" },
      { id: "country", ...countryColumn, align: "left" },
      { id: "event", label: "EVENT", width: eventWidth, align: "left" },
      { id: "actual", label: "ACTUAL", width: actualWidth, align: "right" },
      { id: "forecast", label: "FORECAST", width: forecastWidth, align: "right" },
      { id: "prior", label: "PRIOR", width: priorWidth, align: "right" },
    ];
  }, [filtered, flagged, readerZone, width]);
  const separatorBg = blendHex(colors.bg, colors.border, 0.3);
  const staleness = fetchedAt ? formatStaleness(fetchedAt, now) : "";
  // The calendar has events and the filters hid them all: say which, with the way back.
  // Countries named one by one with nothing in the calendar: a quiet window there, said plainly.
  const unscheduled = useMemo(() => countriesWithoutEvents(countryFilter, events), [countryFilter, events]);
  const filterEmptyTitle = events.length === 0 ? null
    : unscheduled.length > 0 && unscheduled.length === countryFilter.split(",").length ? noScheduledReleasesMessage(unscheduled).replace(/\.$/, "")
    : filteredEmptyTitle(impactFilter, countryFilter);
  const emptyStateHint = !loading && !error
    ? [
        impactFilter !== "all" ? `impact: ${impactFilter}` : null,
        countryFilter !== "all" ? `country: ${countryFilter}` : null,
      ].filter(Boolean).join(" · ") || undefined
    : undefined;

  // Next upcoming event for countdown
  const nextEvent = nextUpcomingEventIdx >= 0 ? filtered[nextUpcomingEventIdx] : undefined;
  // A bank that states no time has a day to count to, not an hour.
  const nextCountdown = !nextEvent ? null
    : hasNoStatedTime(nextEvent) ? shortDayLabel(nextEvent.date)
    : formatCountdown(nextEvent.date.getTime() - now);
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
  // A report of the pane (`gloom fn ECO`) says it too.
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
        // A bank that states no time has none here; its detail says why.
        return { text: hasNoStatedTime(ev) ? "" : timeLabel(ev.date), color: colors.textMuted };
      case "readerTime":
        return { text: hasNoStatedTime(ev) || !readerZone ? "" : zonedClock(ev.date.getTime(), readerZone).label, color: colors.textMuted };
      case "impact": {
        const indicator = impactIndicator(ev.impact);
        return {
          text: indicator.text,
          color: indicator.color,
        };
      }
      case "country": {
        // The ISO code, led on the desktop by the flag drawn as art, never a
        // flag emoji: emoji widths do not match a fixed column and pushed the
        // right-hand columns off the pane. A national euro-area release is
        // its member's (DE for German Ifo), the ECB's the euro area's.
        const country = eventCountry(ev);
        return withCountryFlag({ text: country, color: colors.textMuted }, country, flagged);
      }
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
  }, [flagged, readerZone]);

  const selectedEvent = filtered[selectedIdx];
  const filterControls = (
    <QueryBar
      width={width}
      filters={[
        { id: "impact", label: "Impact", inline: true, value: impactFilter, defaultValue: DEFAULT_IMPACT_FILTER,
          options: FILTER_CYCLE.map((value) => ({ value, label: IMPACT_LABELS[value] })),
          onChange: (value: string) => selectImpactFilter(value as ImpactFilter) },
        { id: "region", label: "Region", inline: true, value: countryFilter, defaultValue: "all",
          // Countries a command named stay a choice beside the regions while they are shown.
          options: [...COUNTRY_CYCLE, ...(COUNTRY_CYCLE.includes(countryFilter) ? [] : [countryFilter])]
            .map((value) => ({ value, label: value === "all" ? "All" : value.split(",").join(", ") })),
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
      emptyContent={filterEmptyTitle ? (
        <Box width="100%" paddingX={1} paddingY={1}>
          <EmptyState title={filterEmptyTitle} actions={<Button label="Show all" compact onPress={showAllEvents} />} />
        </Box>
      ) : undefined}
      emptyStateTitle={loading ? "Loading economic events..." : listedAfter ?? "No events"}
      emptyStateHint={emptyStateHint}
      showHorizontalScrollbar={false}
    />
  );
}

let stopPrintWatch: (() => void) | null = null;

export const economicCalendarModule: PluginModule = {
  series: FRED_CATALOG_SERIES,
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
    reportOptions: [{
      key: "country",
      type: "string",
      placeholder: "countries",
      description: "Regions or two-letter country codes to list, comma separated: US, G7, EU, or such as MX,BR,ZA",
      example: "--country MX,BR,ZA",
      exampleWithoutArgument: true,
      normalize: (value) => {
        const parsed = parseCountryFilter(value);
        if ("error" in parsed) throw new Error(`${parsed.error} ${COUNTRY_FILTER_HINT}`);
        return parsed.filter;
      },
    }],
    settings: {
      title: "Economic Calendar Settings",
      fields: [{
        key: ECON_PRINT_NOTIFICATIONS_ENABLED_KEY,
        label: "Notifications",
        description: "Notify when a high-impact release prints, even while this pane is closed.",
        type: "toggle",
        storage: "plugin",
      }],
    },
  }],
  paneTemplates: [{
    id: "econ-calendar-pane",
    paneId: "econ-calendar",
    label: "Economic Calendar",
    description: "Upcoming economic events, releases, and indicators.",
    // "econ" stays a keyword so the old ECON prefix still finds this pane.
    keywords: ["econ", "economic", "calendar", "events", "macro", "releases", "fed", "cpi", "gdp", "rate decision", "ipca",
      "brazil inflation"],
    // ECO MX,BR opens the calendar on those countries.
    shortcut: {
      prefix: "ECO",
      argKind: "text",
      argPlaceholder: "countries",
      argOptional: true,
      openWithoutArg: true,
      argOptions: () => [
        { value: "US", label: "United States" },
        { value: "G7", label: "G7" },
        { value: "EU", label: "Euro area" },
        { value: "MX,BR,ZA,IN,KR", label: "Mexico, Brazil, South Africa, India and Korea" },
      ],
    },
    createInstance: (_context, options) => {
      const typed = options?.arg?.trim();
      if (!typed) return {};
      const parsed = parseCountryFilter(typed);
      if ("error" in parsed) throw new Error(`${parsed.error} ${COUNTRY_FILTER_HINT}`);
      return { params: commandRequestParams({ country: parsed.filter }) };
    },
  }],
  setup(ctx) {
    attachEconCalendarPersistence(ctx.persistence);
    stopPrintWatch?.();
    stopPrintWatch = setupHighImpactPrintNotifications(ctx);
  },
  dispose() {
    stopPrintWatch?.();
    stopPrintWatch = null;
    resetEconCalendarPersistence();
  },
};
