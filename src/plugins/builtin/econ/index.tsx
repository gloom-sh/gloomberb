import { Box, Text } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  SegmentedControl,
  type DataTableCell,
  type PaneFooterSegment,
} from "../../../components";
import { usePluginPaneState } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
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
  type CountryFilter,
  type DisplayRow,
  type EconCalendarColumn,
  type ImpactFilter,
} from "./calendar-model";
import { usePaneStatusFooter } from "../shared/pane-footer";

const IMPACT_LABELS: Record<ImpactFilter, string> = {
  all: "All",
  high: "High",
  medium: "Med",
  low: "Low",
};

function EconCalendarPane({ focused, width, height }: PaneProps) {
  const [initialCache] = useState(() => getCalendarCache());
  const [events, setEvents] = useState<EconEvent[]>(initialCache?.data ?? []);
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(initialCache?.stale ?? false);
  const [fetchedAt, setFetchedAt] = useState<number | null>(initialCache?.fetchedAt ?? null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [impactFilter, setImpactFilter] = usePluginPaneState<ImpactFilter>("impactFilter", "all");
  const [countryFilter, setCountryFilter] = usePluginPaneState<CountryFilter>("countryFilter", "all");
  const [now, setNow] = useState(Date.now());
  const [detailEvent, setDetailEvent] = useState<EconEvent | null>(null);

  const fetchGenRef = useRef(0);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const headerScrollRef = useRef<ScrollBoxRenderable>(null);

  const load = useCallback(async (force = false) => {
    fetchGenRef.current += 1;
    const gen = fetchGenRef.current;
    setLoading(true);
    setError(null);

    try {
      const result = await loadCalendar(force);
      if (fetchGenRef.current !== gen) return;
      setEvents(result.data);
      setFetchedAt(result.fetchedAt);
      setStale(result.stale);
      setError(result.refreshError ?? null);
      if (force) setSelectedIdx(0);
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchGenRef.current === gen) {
        setLoading(false);
        setSettled(true);
      }
    }
  }, []);

  // loadCalendar serves a fresh cache without a request, so the pane can always
  // ask and still follow the global cadence once the cache goes stale.
  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(() => { void load(false); }, [load]);
  useAutoRefresh(stale ? null : fetchedAt, refresh);

  // Tick every 30s to update staleness + countdown
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const filtered = useMemo(() => events
    .filter((ev) => matchesImpact(ev, impactFilter) && matchesCountry(ev, countryFilter))
    .sort((a, b) => b.date.getTime() - a.date.getTime()),
  [countryFilter, events, impactFilter]);

  // Build display rows with separator headers and NOW marker
  const today = new Date(now);
  const rows: DisplayRow[] = [];
  let lastDateKey = "";
  let nowInserted = false;
  const hasPastEvents = filtered.some((ev) => ev.date.getTime() <= now);
  const hasFutureEvents = filtered.some((ev) => ev.date.getTime() > now);

  for (let i = 0; i < filtered.length; i++) {
    const ev = filtered[i]!;
    const dk = dateKey(ev.date);

    // Insert date separator if new day
    if (dk !== lastDateKey) {
      lastDateKey = dk;
      rows.push({ kind: "separator", key: `separator-${dk}`, label: dayLabel(ev.date, today) });
    }

    // Reverse chronological order puts upcoming events above the present marker.
    if (hasPastEvents && hasFutureEvents && !nowInserted && ev.date.getTime() <= now) {
      nowInserted = true;
      rows.push({ kind: "now", key: "now" });
    }

    rows.push({ kind: "event", key: `event-${ev.id}-${i}`, event: ev, eventIdx: i });
  }

  // Map from eventIdx to flat row index (for scroll tracking)
  const eventIdxToRowIdx = new Map<number, number>();
  let nowRowIdx = -1;
  let nextUpcomingEventIdx = -1;
  let nextUpcomingTime = Number.POSITIVE_INFINITY;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r]!;
    if (row.kind === "event") {
      eventIdxToRowIdx.set(row.eventIdx, r);
      const eventTime = row.event.date.getTime();
      if (eventTime > now && eventTime < nextUpcomingTime) {
        nextUpcomingEventIdx = row.eventIdx;
        nextUpcomingTime = eventTime;
      }
    } else if (row.kind === "now") {
      nowRowIdx = r;
    }
  }

  // On initial load, scroll to NOW and select the first upcoming event
  const initialScrollDone = useRef(false);
  useEffect(() => {
    if (initialScrollDone.current || filtered.length === 0) return;
    if (nextUpcomingEventIdx >= 0) {
      setSelectedIdx(nextUpcomingEventIdx);
    }
    const sb = scrollRef.current;
    if (sb?.viewport && nowRowIdx >= 0) {
      // Position NOW a few rows from the top so you can see context
      const scrollTarget = Math.max(0, nowRowIdx - 3);
      sb.scrollTo(scrollTarget);
    }
    initialScrollDone.current = true;
  }, [filtered.length]);

  // Next upcoming event for countdown
  const nextEvent = nextUpcomingEventIdx >= 0 ? filtered[nextUpcomingEventIdx] : undefined;
  const nextCountdown = nextEvent ? formatCountdown(nextEvent.date.getTime() - now) : null;
  const selectImpactFilter = useCallback((value: ImpactFilter) => {
    setImpactFilter(value);
    setSelectedIdx(0);
  }, [setImpactFilter]);
  const selectCountryFilter = useCallback((value: CountryFilter) => {
    setCountryFilter(value);
    setSelectedIdx(0);
  }, [setCountryFilter]);
  const cycleImpactFilter = useCallback(() => {
    setImpactFilter((prev) => FILTER_CYCLE[(FILTER_CYCLE.indexOf(prev) + 1) % FILTER_CYCLE.length]!);
    setSelectedIdx(0);
  }, [setImpactFilter]);
  const cycleCountryFilter = useCallback(() => {
    setCountryFilter((prev) => COUNTRY_CYCLE[(COUNTRY_CYCLE.indexOf(prev) + 1) % COUNTRY_CYCLE.length]!);
    setSelectedIdx(0);
  }, [setCountryFilter]);

  const handleRootKeyDown = useCallback((event: {
    name?: string;
    preventDefault?: () => void;
    stopPropagation?: () => void;
  }) => {
    if (event.name === "r") {
      event.stopPropagation?.();
      event.preventDefault?.();
      load(true);
      return true;
    } else if (event.name === "f") {
      event.stopPropagation?.();
      event.preventDefault?.();
      cycleImpactFilter();
      return true;
    } else if (event.name === "c") {
      event.stopPropagation?.();
      event.preventDefault?.();
      cycleCountryFilter();
      return true;
    }
    return false;
  }, [cycleCountryFilter, cycleImpactFilter, load]);

  const columns = useMemo<EconCalendarColumn[]>(() => {
    const timeWidth = 6;
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
      { id: "time", label: "TIME", width: timeWidth, align: "left" },
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
  const emptyStateHint = settled && !loading && !error
    ? [
        impactFilter !== "all" ? `impact: ${impactFilter}` : null,
        countryFilter !== "all" ? `country: ${countryFilter}` : null,
      ].filter(Boolean).join(" · ") || undefined
    : undefined;

  const calendarStatus = useMemo<PaneFooterSegment[]>(() => [
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(staleness ? [{ id: "updated", parts: [{ text: staleness, tone: "muted" as const }] }] : []),
  ], [stale, staleness]);
  usePaneStatusFooter({
    registrationId: "econ-calendar",
    loading,
    error,
    info: calendarStatus,
  });

  const handleHeaderClick = useCallback(() => {}, []);
  const openDisplayRow = useCallback((row: DisplayRow) => {
    if (row.kind !== "event") return;
    setDetailEvent(row.event);
  }, []);
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
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    if (row.kind !== "event") return { text: "" };

    const ev = row.event;
    const selectedColor = rowState.selected ? colors.selectedText : undefined;

    switch (column.id) {
      case "time":
        return { text: ev.time, color: selectedColor ?? colors.textMuted };
      case "impact": {
        const indicator = impactIndicator(ev.impact);
        return {
          text: indicator.text,
          color: selectedColor ?? indicator.color,
        };
      }
      case "country":
        // The ISO code, not a flag emoji: emoji widths do not match a fixed
        // column and pushed the right-hand columns off the pane.
        return { text: ev.country, color: selectedColor ?? colors.textMuted };
      case "event":
        return { text: ev.event, color: selectedColor ?? colors.text };
      case "actual":
        return {
          text: ev.actual ?? "—",
          color: selectedColor ?? actualColor(ev.actual, ev.forecast),
        };
      case "forecast":
        return { text: ev.forecast ?? "—", color: selectedColor ?? colors.textDim };
      case "prior":
        return { text: ev.prior ?? "—", color: selectedColor ?? colors.textDim };
    }
  }, []);

  const selectedEvent = filtered[selectedIdx];
  const filterControls = (
    <Box height={1} flexDirection="row" paddingX={1} gap={2} overflow="hidden">
      <SegmentedControl
        options={FILTER_CYCLE.map((value) => ({ value, label: IMPACT_LABELS[value] }))}
        value={impactFilter}
        onChange={(value) => selectImpactFilter(value as ImpactFilter)}
      />
      <SegmentedControl
        options={COUNTRY_CYCLE.map((value) => ({ value, label: value === "all" ? "All" : value }))}
        value={countryFilter}
        onChange={(value) => selectCountryFilter(value as CountryFilter)}
      />
      <Box flexGrow={1} />
      {nextEvent && nextCountdown && width >= 88 && (
        <Text fg={colors.textMuted}>
          {`next ${nextEvent.event.slice(0, 16).trimEnd()} ${nextCountdown}`}
        </Text>
      )}
      {selectedEvent && (
        <Text fg={colors.textDim}>{dayLabel(selectedEvent.date, today)}</Text>
      )}
    </Box>
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
      onBack={() => setDetailEvent(null)}
      detailContent={detailContent}
      rootWidth={width}
      rootHeight={Math.max(1, height - 1)}
      rootBefore={filterControls}
      onRootKeyDown={handleRootKeyDown}
      selection={{
        kind: "index",
        selectedIndex: eventIdxToRowIdx.get(selectedIdx) ?? selectedIdx,
        onChange: (_index, row) => {
          if (row.kind === "event") setSelectedIdx(row.eventIdx);
        },
      }}
      columns={columns}
      items={rows}
      isNavigable={(row) => row.kind === "event"}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={handleHeaderClick}
      headerScrollRef={headerScrollRef}
      scrollRef={scrollRef}
      getItemKey={(row) => row.key}
      onActivate={openDisplayRow}
      renderSectionHeader={renderSectionHeader}
      renderCell={renderCell}
      emptyStateTitle={loading || !settled ? "Loading economic events..." : "No events"}
      emptyStateHint={emptyStateHint}
      showHorizontalScrollbar={false}
    />
  );
}

export const economicCalendarModule: PluginModule = {
  panes: [{
    id: "econ-calendar",
    name: "Economic Calendar",
    icon: "E",
    component: EconCalendarPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 100, height: 30 },
  }],
  paneTemplates: [{
    id: "econ-calendar-pane",
    paneId: "econ-calendar",
    label: "Economic Calendar",
    description: "Upcoming economic events, releases, and indicators.",
    keywords: ["econ", "economic", "calendar", "events", "macro", "releases", "fed", "cpi", "gdp"],
    shortcut: { prefix: "ECON" },
  }],
  setup(ctx) {
    attachEconCalendarPersistence(ctx.persistence);
  },
  dispose() {
    resetEconCalendarPersistence();
  },
};
