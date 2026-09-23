import { Box, Text } from "../../../ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TextAttributes, type ScrollBoxRenderable } from "../../../ui";
import {
  DataTableStackView,
  QueryBar,
  type DataTableCell,
  type PaneFooterSegment,
} from "../../../components";
import { usePluginPaneState } from "../../runtime";
import { useAutoRefresh } from "../shared/auto-refresh";
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
  timeLabel,
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
  // The selected row and the open event are remembered by event id, so a
  // reload or a shared layout comes back to the same release.
  const [selectedKey, setSelectedKey] = usePluginPaneState<string | null>("selectedKey", null);
  const [impactFilter, setImpactFilter] = usePluginPaneState<ImpactFilter>("impactFilter", "all");
  const [countryFilter, setCountryFilter] = usePluginPaneState<CountryFilter>("countryFilter", "all");
  const [now, setNow] = useState(Date.now());
  const [openKey, setOpenKey] = usePluginPaneState<string | null>("openKey", null);

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
      if (force) setSelectedKey(null);
    } catch (err) {
      if (fetchGenRef.current !== gen) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (fetchGenRef.current === gen) {
        setLoading(false);
        setSettled(true);
      }
    }
  }, [setSelectedKey]);

  // loadCalendar serves a fresh cache without a request, so the pane can always
  // ask and still follow the global cadence once the cache goes stale.
  useEffect(() => { void load(); }, [load]);
  const refresh = useCallback(() => { void load(false); }, [load]);
  useAutoRefresh(stale ? null : fetchedAt, refresh);

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
    .sort((a, b) => b.date.getTime() - a.date.getTime()),
  [countryFilter, events, impactFilter]);
  const selectedIdx = Math.max(0, filtered.findIndex((ev) => ev.id === selectedKey));
  const detailEvent = useMemo(
    () => (openKey ? events.find((ev) => ev.id === openKey) ?? null : null),
    [events, openKey],
  );

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
      setSelectedKey(filtered[nextUpcomingEventIdx]?.id ?? null);
    }
    const sb = scrollRef.current;
    if (sb?.viewport && nowRowIdx >= 0) {
      // Position NOW a few rows from the top so you can see context
      const scrollTarget = Math.max(0, nowRowIdx - 3);
      sb.scrollTo(scrollTarget);
    }
    initialScrollDone.current = true;
  }, [filtered.length]);

  const selectImpactFilter = useCallback((value: ImpactFilter) => {
    setImpactFilter(value);
    setSelectedKey(null);
  }, [setImpactFilter, setSelectedKey]);
  const selectCountryFilter = useCallback((value: CountryFilter) => {
    setCountryFilter(value);
    setSelectedKey(null);
  }, [setCountryFilter, setSelectedKey]);
  const cycleImpactFilter = useCallback(() => {
    setImpactFilter((prev) => FILTER_CYCLE[(FILTER_CYCLE.indexOf(prev) + 1) % FILTER_CYCLE.length]!);
    setSelectedKey(null);
  }, [setImpactFilter, setSelectedKey]);
  const cycleCountryFilter = useCallback(() => {
    setCountryFilter((prev) => COUNTRY_CYCLE[(COUNTRY_CYCLE.indexOf(prev) + 1) % COUNTRY_CYCLE.length]!);
    setSelectedKey(null);
  }, [setCountryFilter, setSelectedKey]);

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

  // Next upcoming event for countdown
  const nextEvent = nextUpcomingEventIdx >= 0 ? filtered[nextUpcomingEventIdx] : undefined;
  const nextCountdown = nextEvent ? formatCountdown(nextEvent.date.getTime() - now) : null;
  // The countdown changes every tick, so it is footer status, not query bar
  // context; the footer ellipsizes a long event name.
  const nextText = nextEvent && nextCountdown ? `next ${nextEvent.event} ${nextCountdown}` : null;
  const calendarStatus = useMemo<PaneFooterSegment[]>(() => [
    ...(nextText && !detailEvent ? [{ id: "next", parts: [{ text: nextText, tone: "muted" as const }] }] : []),
    ...(stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
    ...(staleness ? [{ id: "updated", parts: [{ text: staleness, tone: "muted" as const }] }] : []),
  ], [detailEvent, nextText, stale, staleness]);
  usePaneStatusFooter({
    registrationId: "econ-calendar",
    loading,
    error,
    info: calendarStatus,
  });

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
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    if (row.kind !== "event") return { text: "" };

    const ev = row.event;
    const selectedColor = rowState.selected ? colors.selectedText : undefined;

    switch (column.id) {
      case "time":
        return { text: timeLabel(ev.date), color: selectedColor ?? colors.textMuted };
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
          if (row.kind === "event") setSelectedKey(row.event.id);
        },
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
