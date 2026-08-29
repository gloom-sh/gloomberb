import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiClient, type CloudWorldVenueMapPayload, type CloudWorldVenuePayload } from "../../../api-client";
import {
  DataTableView,
  EmptyState,
  InputSearchBar,
  Spinner,
  usePaneFooter,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
} from "../../../components";
import { useShortcut } from "../../../react/input";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, type InputRenderable } from "../../../ui";
import { isPlainKey } from "../../../utils/keyboard";
import {
  filterWorldVenues,
  formatVenueCountdown,
  formatVenueLocalTime,
  venueRemainingSeconds,
} from "./model";
import { WorldVenueMap } from "./map";

export const WORLD_VENUE_MAP_PANE_ID = "world-venue-map";

type VenueColumnId = "status" | "mic" | "name" | "time";
type VenueColumn = DataTableColumn & { id: VenueColumnId };

function venueColumns(width: number): VenueColumn[] {
  const timeWidth = width >= 34 ? 6 : 0;
  const fixed = 1 + 6 + timeWidth;
  return [
    { id: "status", label: "", width: 1, align: "left" },
    { id: "mic", label: "MIC", width: 6, align: "left" },
    { id: "name", label: "VENUE", width: Math.max(10, width - fixed - 6), flexGrow: 1, align: "left" },
    ...(timeWidth ? [{ id: "time" as const, label: "LOCAL", width: timeWidth, align: "left" as const }] : []),
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function SelectedVenueHeader({
  venue,
  checkedAt,
  now,
  width,
}: {
  venue: CloudWorldVenuePayload | null;
  checkedAt: number;
  now: number;
  width: number;
}) {
  if (!venue) return <Box height={2} />;
  const remaining = formatVenueCountdown(venueRemainingSeconds(venue, checkedAt, now));
  const state = venue.isOpen ? "OPEN" : "CLOSED";
  const transition = remaining ? `${venue.isOpen ? "closes" : "opens"} ${remaining}` : "";
  return (
    <Box flexDirection="column" height={2} width={width} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{venue.mic}</Text>
        <Text fg={venue.isOpen ? colors.positive : colors.textDim}>{state}</Text>
      </Box>
      <Text fg={colors.textMuted}>
        {`${venue.city}, ${venue.country} · ${formatVenueLocalTime(venue.timezone, now)}${transition ? ` · ${transition}` : ""}`}
      </Text>
    </Box>
  );
}

export function WorldVenueMapPane({ focused, width, height }: PaneProps) {
  const [data, setData] = useState<CloudWorldVenueMapPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchFocusToken, setSearchFocusToken] = useState(0);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const inputRef = useRef<InputRenderable | null>(null);
  const generationRef = useRef(0);
  const dataRef = useRef<CloudWorldVenueMapPayload | null>(null);
  dataRef.current = data;

  const load = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!dataRef.current) setLoading(true);
    setError(null);
    try {
      const response = await apiClient.getCloudWorldVenues();
      if (generation !== generationRef.current) return;
      if (!response.data) throw new Error(response.reasonCode ?? "World venue data unavailable");
      const next = response.stale ? { ...response.data, stale: true } : response.data;
      dataRef.current = next;
      setData(next);
      setLoading(false);
    } catch (caught) {
      if (generation !== generationRef.current) return;
      setError(errorMessage(caught));
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (!data) return;
    const delay = Math.max(30_000, Math.min(15 * 60_000, data.refreshAt - Date.now()));
    const timer = setTimeout(() => void load(), delay);
    return () => clearTimeout(timer);
  }, [data, load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  const venues = useMemo(() => filterWorldVenues(data?.venues ?? [], query), [data?.venues, query]);
  useEffect(() => {
    if (selectedMic && venues.some((venue) => venue.mic === selectedMic)) return;
    setSelectedMic(venues[0]?.mic ?? null);
  }, [selectedMic, venues]);

  const selectedVenue = useMemo(
    () => venues.find((venue) => venue.mic === selectedMic) ?? null,
    [selectedMic, venues],
  );
  const focusSearch = useCallback(() => {
    setSearchFocused(true);
    setSearchFocusToken((value) => value + 1);
  }, []);
  const blurSearch = useCallback(() => setSearchFocused(false), []);
  const refresh = useCallback(() => void load(), [load]);

  useShortcut((event) => {
    if (searchFocused || event.targetEditable) return;
    if (isPlainKey(event, "/")) {
      event.preventDefault();
      event.stopPropagation();
      focusSearch();
    } else if (isPlainKey(event, "r")) {
      event.preventDefault();
      event.stopPropagation();
      refresh();
    }
  }, { allowEditable: true, enabled: focused });

  const handleTableKey = useCallback((event: DataTableKeyEvent) => {
    if (isPlainKey(event, "/")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      focusSearch();
      return true;
    }
    if (isPlainKey(event, "r")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      refresh();
      return true;
    }
    return false;
  }, [focusSearch, refresh]);

  const openCount = venues.reduce((count, venue) => count + Number(venue.isOpen), 0);
  usePaneFooter(WORLD_VENUE_MAP_PANE_ID, () => ({
    info: [
      ...(loading && !data ? [{ id: "loading", parts: [{ text: "LOADING", tone: "muted" as const }] }] : []),
      ...(data && !data.stale ? [{ id: "live", parts: [{ text: "LIVE", tone: "positive" as const }] }] : []),
      ...(data?.stale ? [{ id: "stale", parts: [{ text: "STALE", tone: "warning" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
    hints: [
      { id: "search", key: "/", label: "search", onPress: focusSearch },
      { id: "refresh", key: "r", label: "efresh", onPress: refresh },
    ],
  }), [data, error, focusSearch, loading, refresh]);

  const horizontal = width >= 88;
  const sidebarWidth = horizontal ? Math.max(34, Math.min(46, Math.round(width * 0.34))) : width;
  const mapWidth = horizontal ? Math.max(1, width - sidebarWidth - 1) : width;
  const mapSectionHeight = horizontal ? height : Math.max(8, Math.floor(height * 0.52));
  const tableHeight = horizontal ? height : Math.max(4, height - mapSectionHeight);
  const mapHeight = Math.max(2, mapSectionHeight - 2);
  const columns = useMemo(() => venueColumns(sidebarWidth), [sidebarWidth]);

  const renderCell = useCallback((
    venue: CloudWorldVenuePayload,
    column: VenueColumn,
    _index: number,
    rowState: { selected: boolean },
  ): DataTableCell => {
    const selectedColor = rowState.selected ? colors.selectedText : undefined;
    switch (column.id) {
      case "status":
        return {
          text: venue.isOpen ? "●" : "○",
          color: selectedColor ?? (venue.isOpen ? colors.positive : colors.textDim),
        };
      case "mic":
        return { text: venue.mic, color: selectedColor ?? colors.textBright, attributes: TextAttributes.BOLD };
      case "name":
        return { text: venue.title, color: selectedColor ?? colors.textMuted };
      case "time":
        return { text: formatVenueLocalTime(venue.timezone, now), color: selectedColor ?? colors.textDim };
    }
  }, [now]);

  const sidebarHeader = (
    <Box flexDirection="column" width={sidebarWidth} height={2}>
      <Box flexDirection="row" justifyContent="space-between" width="100%" paddingX={1}>
        <Text fg={colors.textDim}>VENUES</Text>
        <Box flexDirection="row">
          <Text fg={colors.positive}>{`${openCount} OPEN`}</Text>
          <Text fg={colors.textDim}>{` · ${venues.length - openCount} CLOSED`}</Text>
        </Box>
      </Box>
      <InputSearchBar
        value={query}
        focused={focused}
        active={searchFocused}
        width={sidebarWidth}
        focusToken={searchFocusToken}
        inputRef={inputRef}
        placeholder="Filter venues..."
        debounceMs={80}
        normalizeValue={(value) => value.trim()}
        onFocus={focusSearch}
        onBlur={blurSearch}
        onNavigateDown={blurSearch}
        onQueryChange={setQuery}
      />
    </Box>
  );

  const table = (
    <DataTableView<CloudWorldVenuePayload, VenueColumn>
      focused={focused && !searchFocused}
      selection={{
        kind: "id",
        selectedId: selectedMic,
        getId: (venue) => venue.mic,
        onChange: (mic) => setSelectedMic(mic),
      }}
      rootWidth={sidebarWidth}
      rootHeight={tableHeight}
      rootBefore={sidebarHeader}
      columns={columns}
      items={venues}
      sortColumnId={null}
      sortDirection="asc"
      onHeaderClick={() => {}}
      getItemKey={(venue) => venue.mic}
      renderCell={renderCell}
      emptyStateTitle={query.trim() ? "No matching venues." : "No venue data."}
      emptyStateHint={query.trim() ? "Clear search." : undefined}
      onRootKeyDown={handleTableKey}
    />
  );

  if (!data && loading) {
    return <Box width={width} height={height} alignItems="center" justifyContent="center"><Spinner label="Loading world venues..." /></Box>;
  }
  if (!data) {
    return <EmptyState title="World venues unavailable." hint={error ?? "Try again."} />;
  }

  const map = (
    <Box flexDirection="column" width={mapWidth} height={mapSectionHeight} overflow="hidden">
      <SelectedVenueHeader venue={selectedVenue} checkedAt={data.checkedAt} now={now} width={mapWidth} />
      <WorldVenueMap
        venues={venues}
        selectedMic={selectedMic}
        width={mapWidth}
        height={mapHeight}
        onSelect={(venue) => setSelectedMic(venue.mic)}
      />
    </Box>
  );

  return horizontal ? (
    <Box flexDirection="row" width={width} height={height}>
      {table}
      <Box width={1} height={height} backgroundColor={colors.border} />
      {map}
    </Box>
  ) : (
    <Box flexDirection="column" width={width} height={height}>
      {map}
      {table}
    </Box>
  );
}
