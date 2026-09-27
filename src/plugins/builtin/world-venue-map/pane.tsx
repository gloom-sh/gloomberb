import { useCallback, useEffect, useMemo, useState } from "react";
import { apiClient, type CloudWorldVenueMapPayload, type CloudWorldVenuePayload } from "../../../api-client";
import {
  DataTableView,
  EmptyState,
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  PaneSidebar,
  PaneStatusBody,
  QueryBar,
  readStoredPaneSidebarWidth,
  shouldShowPaneSidebar,
  usePaneFooter,
  useQueryBarSearch,
  type DataTableCell,
  type DataTableColumn,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useShortcut } from "../../../react/input";
import { useAsyncResource, usePluginPaneState } from "../../../public/react";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useUiCapabilities } from "../../../ui";
import { WorldVenueMap } from "./map";
import {
  filterWorldVenues,
  formatVenueCountdown,
  formatVenueLocalTime,
  venueRemainingSeconds,
} from "./model";

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

async function loadWorldVenues(): Promise<CloudWorldVenueMapPayload> {
  const response = await apiClient.getCloudWorldVenues();
  if (!response.data) throw new Error(response.reasonCode ?? "World venue data unavailable");
  return response.stale ? { ...response.data, stale: true } : response.data;
}

export function WorldVenueMapPane({ focused, width, height }: PaneProps) {
  // A background refresh keeps the venues on screen, so loading only shows before the first answer.
  const { data, loading, error, load } = useAsyncResource(loadWorldVenues);
  const [query, setQuery] = useState("");
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

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
  const refresh = useCallback(() => void load(), [load]);
  // The search field only exists once venues have loaded; before that `/` has
  // nothing to focus and must not leave the pane waiting on a missing field.
  const searchable = !!data;
  const searchOpen = searchable && searchFocused;

  useShortcut((event) => {
    if (searchOpen || event.targetEditable) return;
    handleRefreshKey(event, refresh, { stopPropagation: true });
  }, { allowEditable: true, enabled: focused });

  usePaneFooter(WORLD_VENUE_MAP_PANE_ID, () => ({
    info: [
      ...(loading && !data ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(data && !data.stale ? [{ id: "live", parts: [{ text: "live", tone: "positive" as const }] }] : []),
      ...(data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
      ...(error ? [{ id: "error", parts: [{ text: error, tone: "warning" as const }] }] : []),
    ],
    hints: [
      ...(searchable ? [{ id: "search", key: "/", label: "search", onPress: focusSearch }] : []),
    ],
  }), [data, error, focusSearch, loading, searchable]);

  const { nativePaneChrome } = useUiCapabilities();
  const [storedSidebarWidth, setStoredSidebarWidth] = usePluginPaneState<number | null>("sidebarWidth", null);
  const [draggedSidebarWidth, setDraggedSidebarWidth] = useState<number | null>(null);
  const horizontal = shouldShowPaneSidebar(data?.venues.length ?? 0, width, height);
  // Venue names need more room than a conversation list, so the width the pane
  // starts at is its own; a drag replaces it and is kept with the pane. The
  // terminal's divider cell sits inside the sidebar, so it is added on top to
  // keep the list 34 cells wide, which is what the LOCAL column needs.
  const defaultSidebarWidth = Math.max(34, Math.min(46, Math.round(width * 0.34))) + (nativePaneChrome ? 0 : 1);
  const sidebarWidth = horizontal
    ? getPaneSidebarWidth(
      width,
      !!nativePaneChrome,
      draggedSidebarWidth ?? readStoredPaneSidebarWidth(storedSidebarWidth) ?? defaultSidebarWidth,
    )
    : width;
  const sidebarRange = getPaneSidebarWidthRange(width);
  // The terminal draws the divider as a cell inside the sidebar; the desktop as a hairline.
  const listWidth = horizontal && !nativePaneChrome ? Math.max(1, sidebarWidth - 1) : sidebarWidth;
  const mapWidth = horizontal ? Math.max(1, width - sidebarWidth) : width;
  const mapSectionHeight = horizontal ? height : Math.max(8, Math.floor(height * 0.52));
  const tableHeight = horizontal ? height : Math.max(4, height - mapSectionHeight);
  const mapHeight = Math.max(2, mapSectionHeight - 2);
  const columns = useMemo(() => venueColumns(listWidth), [listWidth]);

  const renderCell = useCallback((
    venue: CloudWorldVenuePayload,
    column: VenueColumn,
  ): DataTableCell => {
    switch (column.id) {
      case "status":
        return {
          text: venue.isOpen ? "●" : "○",
          color: venue.isOpen ? colors.positive : colors.textDim,
        };
      case "mic":
        return { text: venue.mic, color: colors.textBright, attributes: TextAttributes.BOLD };
      case "name":
        return { text: venue.title, color: colors.textMuted };
      case "time":
        return { text: formatVenueLocalTime(venue.timezone, now), color: colors.textDim };
    }
  }, [now]);

  const sidebarHeader = (
    <QueryBar
      width={listWidth}
      search={{
        value: query,
        onChange: setQuery,
        placeholder: "Filter venues...",
        focused,
        ...searchProps,
        debounceMs: 80,
        normalizeValue: (value: string) => value.trim(),
      }}
    />
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
      rootWidth={listWidth}
      rootHeight={tableHeight}
      rootBefore={sidebarHeader}
      columns={columns}
      items={venues}
      sortColumnId={null}
      sortDirection="asc"
      getItemKey={(venue) => venue.mic}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      emptyStateTitle={query.trim() ? "No matching venues." : "No venue data."}
      emptyStateHint={query.trim() ? "Clear search." : undefined}
    />
  );

  if (!data && loading) {
    return <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading world venues..." />;
  }
  if (!data) {
    return <EmptyState status={error ? "error" : "empty"} title="World venues unavailable." hint={error ?? "Try again."} />;
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
      <PaneSidebar
        width={sidebarWidth}
        height={height}
        focused={focused}
        resize={{
          min: sidebarRange.min,
          max: sidebarRange.max,
          onResize: setDraggedSidebarWidth,
          onResizeEnd: (next) => {
            setStoredSidebarWidth(next);
            setDraggedSidebarWidth(null);
          },
        }}
      >
        {table}
      </PaneSidebar>
      {map}
    </Box>
  ) : (
    <Box flexDirection="column" width={width} height={height}>
      {map}
      {table}
    </Box>
  );
}
