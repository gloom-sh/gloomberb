import { Box } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import { DataTableStackView, type DataTableCell, type PaneFooterSegment } from "../../../components";
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
  countryFlag,
  dateKey,
  dayLabel,
  formatCountdown,
  formatStaleness,
  getCalendarCache,
  getFreshCalendarCache,
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
import { attachFredSeriesPersistence } from "../../../data/fred-series";
import { usePaneStatusFooter } from "../shared/pane-footer";

function EconCalendarPane({ focused, width, height }: PaneProps) {
  const [initialCache] = useState(() => getCalendarCache());
  const [events, setEvents] = useState<EconEvent[]>(initialCache?.data ?? []);
  const [loading, setLoading] = useState(!initialCache || initialCache.stale);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [impactFilter, setImpactFilter] = useState<ImpactFilter>("all");
  const [countryFilter, setCountryFilter] = useState<CountryFilter>("all");
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
      const data = await loadCalendar(force);
      if (fetchGenRef.current !== gen) return;
      setEvents(data);
      if (force) setSelectedIdx(0);
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchGenRef.current === gen) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const cached = getFreshCalendarCache();
    if (cached) {
      setEvents(cached.data);
      return;
    }
    load();
  }, [load]);

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
  const cycleImpactFilter = useCallback(() => {
    setImpactFilter((prev) => {
      const idx = FILTER_CYCLE.indexOf(prev);
      return FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length]!;
    });
    setSelectedIdx(0);
  }, []);
  const cycleCountryFilter = useCallback(() => {
    setCountryFilter((prev) => {
      const idx = COUNTRY_CYCLE.indexOf(prev);
      return COUNTRY_CYCLE[(idx + 1) % COUNTRY_CYCLE.length]!;
    });
    setSelectedIdx(0);
  }, []);

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
    const flagWidth = 2;
    const actualWidth = 9;
    const forecastWidth = 10;
    const priorWidth = 9;
    const minEventWidth = 12;
    const fixedWidth = timeWidth + impactWidth + flagWidth + actualWidth + forecastWidth + priorWidth;
    const columnCount = 7;
    const eventWidth = Math.max(minEventWidth, width - 2 - columnCount - fixedWidth);

    return [
      { id: "time", label: "TIME", width: timeWidth, align: "left" },
      { id: "impact", label: "IMP", width: impactWidth, align: "left" },
      { id: "country", label: "🌐", width: flagWidth, align: "left" },
      { id: "event", label: "EVENT", width: eventWidth, align: "left" },
      { id: "actual", label: "ACTUAL", width: actualWidth, align: "right" },
      { id: "forecast", label: "FORECAST", width: forecastWidth, align: "right" },
      { id: "prior", label: "PRIOR", width: priorWidth, align: "right" },
    ];
  }, [width]);
  const separatorBg = blendHex(colors.bg, colors.border, 0.3);
  const calendarCache = getCalendarCache();
  const staleness = calendarCache ? formatStaleness(calendarCache.fetchedAt, now) : "";
  const emptyStateHint = !loading && !error
    ? [
        impactFilter !== "all" ? `impact: ${impactFilter}` : null,
        countryFilter !== "all" ? `country: ${countryFilter}` : null,
      ].filter(Boolean).join(" · ") || undefined
    : undefined;

  const calendarStatus = useMemo<PaneFooterSegment[]>(() => [
    ...(impactFilter !== "all" ? [{ id: "impact", parts: [{ text: `impact: ${impactFilter}`, tone: "value" as const }] }] : []),
    ...(countryFilter !== "all" ? [{ id: "country", parts: [{ text: `country: ${countryFilter}`, tone: "value" as const }] }] : []),
    ...(nextEvent && nextCountdown ? [{
      id: "next",
      parts: [{ text: `Next: ${nextEvent.event.length > 18 ? nextEvent.event.slice(0, 18).trimEnd() : nextEvent.event} ${nextCountdown}`, tone: "muted" as const }],
    }] : []),
    ...(staleness ? [{ id: "stale", parts: [{ text: staleness, tone: "muted" as const }] }] : []),
  ], [countryFilter, impactFilter, nextCountdown, nextEvent?.event, staleness]);
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
      const label = " ▸ NOW ";
      const line = "─".repeat(Math.max(0, width - label.length - 2));
      return {
        text: `${label}${line}`,
        color: colors.warning,
        attributes: 0,
      };
    }
    return null;
  }, [separatorBg, width]);
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
        return { text: countryFlag(ev.country), color: selectedColor };
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
      rootHeight={height}
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
      emptyStateTitle={loading ? "Loading economic events..." : "No events"}
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
    attachFredSeriesPersistence(ctx.persistence);
  },
  dispose() {
    resetEconCalendarPersistence();
  },
};
