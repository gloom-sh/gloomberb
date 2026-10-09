import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudWorldVenuePayload } from "../../../api-client";
import type {
  GeoEntityRow,
  GeoFeature,
  GeoLayerInfo,
  GeoSeriesInfo,
  GeoTickerLink,
} from "../../../api-client/geo";
import { usePlanAccess } from "../../../api-client/plan-access";
import {
  DataTableStackView,
  EmptyState,
  getPaneSidebarWidth,
  getPaneSidebarWidthRange,
  PaneSidebar,
  QueryBar,
  readStoredPaneSidebarWidth,
  shouldShowPaneSidebar,
  usePagedRows,
  usePaneFooter,
  usePaneMenuItems,
  usePaneNoticeFooter,
  useQueryBarSearch,
  useTableLoadMore,
  type DataTableCell,
  type PageRequest,
  type PaneHint,
} from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import {
  useAsyncResource,
  usePaneSettingValue,
  usePaneVisible,
  usePluginAppActions,
  usePluginPaneState,
} from "../../../public/react";
import { relativeLuminance } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box, Text, TextAttributes, useUiCapabilities, type ScrollBoxRenderable } from "../../../ui";
import { formatGeoSeriesExpression } from "../chart-composer/series-expression";
import { CLOUD_PLAN_KEY, useCloudUpgradeAction } from "../shared/cloud-upgrade";
import { ENTITY_PAGE_SIZE, loadEntityDetail, loadEntityPage, loadWorldVenues } from "./client";
import { EntityDetail } from "./entity-detail";
import { useWorldMapEvidence } from "./evidence";
import { entityCellText, entityColumns, TICKER_COLUMN_ID, type EntityColumn } from "./entity-table";
import type { GeoLayerState } from "./feed";
import { geoLayerColor, type GeoMapLayer, type GeoMapOverlay, type GeoMapSelection } from "./geo-draw";
import { WORLD_VENUE_MAP_PANE_ID } from "./ids";
import {
  featureAnchor,
  formatGeoValue,
  formatTickerLinks,
  isChangeColumn,
  readVenuesSetting,
  sameGeoView,
  tickerLinkKey,
  VENUES_SETTING_KEY,
  WORLD_GEO_VIEW,
  type GeoView,
} from "./layers";
import { WorldVenueMap, type WorldMapFocus } from "./map";
import { usesClassTones } from "./map-symbols";
import { filterWorldVenues } from "./model";
import { useGeoLayerFeed } from "./use-geo";
import { SelectedVenueHeader } from "./venue-header";

interface LayeredMapViewProps extends PaneProps {
  /** The layers on, already capped. */
  layers: GeoLayerInfo[];
  /** The layer ids or groups the pane was asked for. */
  tokens: readonly string[];
}

interface OpenEntity {
  layer: string;
  id: string;
}

type SortState = { key: string | null; dir: "asc" | "desc" };

/**
 * Zoom an opened entity is shown at: 16 times the world (the server's zoom 4,
 * where dense point layers stop clustering) for a ship or a port, wider for a
 * pipeline or a field.
 */
function openZoom(layer: GeoLayerInfo): number {
  return layer.geometry === "point" ? 16 : 4;
}
const NO_SORT: SortState = { key: null, dir: "asc" };
/** Layers go closer than venues: 64 times the world is the server's zoom 6, where flights and single ports show. */
const LAYERED_MAX_ZOOM = 64;

function featureRow(feature: GeoFeature): GeoEntityRow {
  const [lon, lat] = featureAnchor(feature);
  return { id: feature.id, label: feature.label, lon, lat, props: feature.props, ...(feature.tickers ? { tickers: feature.tickers } : {}) };
}

function ageText(iso: string | null | undefined, now: number): string | null {
  if (!iso) return null;
  const formatted = formatGeoValue(iso, "datetime", now);
  return formatted || null;
}

/** The layer's freshness in footer words: "live · 12s ago", "as of 4 Oct". */
function layerFreshness(state: GeoLayerState, now: number): { text: string; tone: "positive" | "muted" } | null {
  if (state.phase !== "ready") return null;
  const asOf = state.asOf ?? state.layer.asOf;
  if (state.layer.cadence === "live") {
    const age = ageText(asOf, now);
    return { text: age ? `live · ${age}` : "live", tone: "positive" };
  }
  if (state.layer.cadence === "daily" && asOf) {
    const date = new Date(Date.parse(asOf));
    if (!Number.isFinite(date.getTime())) return null;
    return { text: `as of ${date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" })}`, tone: "muted" };
  }
  return null;
}

function layerNotices(states: readonly GeoLayerState[]): string[] {
  return states.flatMap((state) => {
    const { layer } = state;
    if (state.phase === "unavailable") return [`${layer.name}: ${state.note ?? layer.statusNote ?? "unavailable"}.`];
    if (state.phase === "locked") return [`${layer.name} needs Pro.`];
    const notes: string[] = [];
    const partialNote = state.note ?? layer.statusNote;
    if (layer.status === "partial" || state.note) notes.push(`${layer.name}: partial${partialNote ? `, ${partialNote}` : ""}.`);
    if (state.phase === "error" && state.error) notes.push(`${layer.name} could not load: ${state.error}`);
    else if (state.error) notes.push(`${layer.name} could not refresh: ${state.error}`);
    if (state.truncated && !state.clusters.length) notes.push(`${layer.name}: zoom in to see every feature.`);
    return notes;
  });
}

const SelectedEntityHeader = memo(function SelectedEntityHeader({
  row,
  layer,
  color,
  now,
  width,
}: {
  row: GeoEntityRow | null;
  layer: GeoLayerInfo;
  color: string;
  now: number;
  width: number;
}) {
  const colors = useThemeColors();
  if (!row) return <Box height={2} />;
  const seen = typeof row.props.lastSeen === "string" ? ageText(row.props.lastSeen, now) : null;
  const meta = [
    seen ? `seen ${seen}` : null,
    formatTickerLinks(row.tickers) || null,
  ].filter(Boolean).join(" · ");
  return (
    <Box flexDirection="column" height={2} width={width} paddingX={1}>
      <Box flexDirection="row" justifyContent="space-between" width="100%">
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{row.label}</Text>
        <Text fg={color}>{layer.name}</Text>
      </Box>
      <Text fg={colors.textMuted}>{meta}</Text>
    </Box>
  );
});

export function LayeredMapView({ focused, width, height, layers, tokens }: LayeredMapViewProps) {
  const colors = useThemeColors();
  const dark = relativeLuminance(colors.text) > relativeLuminance(colors.bg);
  const { nativePaneChrome } = useUiCapabilities();
  const { createPaneFromTemplate } = usePluginAppActions();
  const visible = usePaneVisible();
  const { hasProAccess } = usePlanAccess();
  const upgrade = useCloudUpgradeAction("map-layers");
  const [venuesSetting] = usePaneSettingValue<boolean | undefined>(VENUES_SETTING_KEY, undefined);
  const venuesOn = readVenuesSetting({ [VENUES_SETTING_KEY]: venuesSetting }, layers.length);
  const { data: venueData } = useAsyncResource(venuesOn ? loadWorldVenues : null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(timer);
  }, []);

  const [view, setView] = useState<GeoView>(WORLD_GEO_VIEW);
  const onViewChange = useCallback((next: GeoView) => {
    setView((current) => sameGeoView(current, next) ? current : next);
  }, []);
  const canAccess = useCallback((layer: GeoLayerInfo) => layer.access !== "pro" || hasProAccess, [hasProAccess]);
  const states = useGeoLayerFeed(layers, view, visible, { canAccess });

  // A layer coloured by class (ships) takes the first colour, so its own never meets the class colours.
  const colorOrder = useMemo(
    () => [...layers].sort((left, right) => Number(usesClassTones(right.id)) - Number(usesClassTones(left.id))),
    [layers],
  );
  const colorFor = useCallback((layerId: string) => {
    const index = colorOrder.findIndex((layer) => layer.id === layerId);
    return geoLayerColor(Math.max(0, index), dark);
  }, [colorOrder, dark]);

  const [savedTableLayer, setTableLayer] = usePluginPaneState<string | null>("map:table", null);
  const tableLayer = layers.find((layer) => layer.id === savedTableLayer)
    ?? layers.find((layer) => layer.status !== "unavailable")
    ?? layers[0]!;
  const tableState = states.find((state) => state.layer.id === tableLayer.id) ?? null;
  const [queries, setQueries] = usePluginPaneState<Record<string, string>>("map:queries", {});
  const query = queries[tableLayer.id] ?? "";
  const setQuery = useCallback((value: string) => setQueries((current) => ({ ...current, [tableLayer.id]: value })), [setQueries, tableLayer.id]);
  const [sorts, setSorts] = usePluginPaneState<Record<string, SortState>>("map:sorts", {});
  const sort = sorts[tableLayer.id] ?? NO_SORT;
  const [selections, setSelections] = usePluginPaneState<Record<string, string>>("map:selected", {});
  const [open, setOpen] = usePluginPaneState<OpenEntity | null>("map:open", null);
  const [selectedMic, setSelectedMic] = useState<string | null>(null);
  const [headerSubject, setHeaderSubject] = useState<"entity" | "venue">("entity");
  const [focus, setFocus] = useState<WorldMapFocus | null>(null);
  const { active: searchFocused, focus: focusSearch, searchProps } = useQueryBarSearch();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const detailScrollRef = useRef<ScrollBoxRenderable>(null);

  const tableLocked = !canAccess(tableLayer) || tableState?.phase === "locked";
  const tableReadable = tableLayer.status !== "unavailable" && tableState?.phase !== "unavailable" && !tableLocked;
  const loadPage = useCallback(async ({ offset, signal }: PageRequest) => {
    const page = await loadEntityPage(tableLayer.id, {
      q: query,
      ...(sort.key ? { sort: sort.key, dir: sort.dir } : {}),
      offset,
    }, signal);
    const rows = page.rows ?? [];
    const total = typeof page.total === "number" ? page.total : null;
    return {
      ...page,
      rows,
      hasMore: rows.length >= ENTITY_PAGE_SIZE && (total === null || offset + rows.length < total),
      nextOffset: offset + rows.length,
    };
  }, [query, sort.dir, sort.key, tableLayer.id]);
  const pages = usePagedRows(tableReadable ? loadPage : null, { getId: (row) => row.id });
  const rows = pages.rows;
  useWorldMapEvidence(tokens, states, rows.length, pages.loading);
  const refresh = useCallback(() => pages.reload(), [pages.reload]);
  usePaneRefreshKey(refresh, { focused: focused && !searchFocused });

  const detailOpen = !!open && open.layer === tableLayer.id;
  const detailLoader = useMemo(
    () => (detailOpen && open ? () => loadEntityDetail(open.layer, open.id) : null),
    [detailOpen, open?.id, open?.layer],
  );
  const detail = useAsyncResource(detailLoader);
  const openRow = detailOpen
    ? rows.find((row) => row.id === open!.id) ?? (detail.data ? featureRow(detail.data.feature) : null)
    : null;

  const selectedId = selections[tableLayer.id] ?? null;
  // The table's cursor starts on its first row, and the map and header follow it from there.
  const selectedRow = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const cursorId = selectedRow?.id ?? null;
  const headerRow = openRow ?? selectedRow;

  const selectRow = useCallback((id: string | null, layerId = tableLayer.id) => {
    setSelections((current) => {
      if (id === null) {
        const { [layerId]: _removed, ...rest } = current;
        return rest;
      }
      return current[layerId] === id ? current : { ...current, [layerId]: id };
    });
  }, [setSelections, tableLayer.id]);

  const openTicker = useCallback((link: GeoTickerLink) => {
    createPaneFromTemplate("new-ticker-detail-pane", { symbol: tickerLinkKey(link) });
  }, [createPaneFromTemplate]);
  const openSeries = useCallback((series: GeoSeriesInfo) => {
    createPaneFromTemplate("chart-composer-pane", { arg: formatGeoSeriesExpression(series.id) });
  }, [createPaneFromTemplate]);

  // The map: one drawn layer per feed state, kept by identity so a pan redraws nothing.
  const mapLayers = useMemo<GeoMapLayer[]>(() => states.map((state) => ({
    id: state.layer.id,
    name: state.layer.name,
    geometry: state.layer.geometry,
    color: colorFor(state.layer.id),
    features: state.features,
    clusters: state.clusters,
  })), [colorFor, states]);
  const selection = useMemo<GeoMapSelection | null>(() => {
    if (headerSubject !== "entity") return null;
    const target = openRow ?? selectedRow;
    if (!target) return null;
    return { layerId: tableLayer.id, id: target.id, longitude: target.lon, latitude: target.lat };
  }, [headerSubject, openRow, selectedRow, tableLayer.id]);
  const trail = useMemo(
    () => (detailOpen && detail.data?.trail?.length ? detail.data.trail.map(([lon, lat]) => [lon, lat] as const) : null),
    [detail.data?.trail, detailOpen],
  );
  // A track arrives with the detail: zoom so it fills about a third of the view.
  const trailKey = detailOpen && trail && trail.length > 1 ? `trail:${open!.id}` : null;
  useEffect(() => {
    if (!trailKey || !trail) return;
    const lons = trail.map(([lon]) => lon);
    const lats = trail.map(([, lat]) => lat);
    const span = Math.max(Math.max(...lons) - Math.min(...lons), (Math.max(...lats) - Math.min(...lats)) * 2, 0.05);
    const last = trail.at(-1)!;
    setFocus({ key: trailKey, longitude: last[0], latitude: last[1], zoom: Math.min(LAYERED_MAX_ZOOM, Math.max(openZoom(tableLayer), 360 / (span * 3))) });
  }, [trailKey]);
  const overlay = useMemo<GeoMapOverlay>(() => ({ layers: mapLayers, selected: selection, trail }), [mapLayers, selection, trail]);

  const venues = useMemo(() => (venuesOn ? filterWorldVenues(venueData?.venues ?? [], "") : []), [venueData?.venues, venuesOn]);
  const selectedVenue: CloudWorldVenuePayload | null = headerSubject === "venue"
    ? venues.find((venue) => venue.mic === selectedMic) ?? null
    : null;

  const onSelectGeo = useCallback(({ layerId, feature }: { layerId: string; feature: GeoFeature }) => {
    setHeaderSubject("entity");
    setTableLayer(layerId);
    selectRow(feature.id, layerId);
    setOpen({ layer: layerId, id: feature.id });
  }, [selectRow, setOpen, setTableLayer]);

  const activeLinks = (openRow ? detail.data?.feature.tickers ?? openRow.tickers : selectedRow?.tickers) ?? [];
  const primaryLink = activeLinks[0] ?? null;
  // The layer's main series (transits, port calls) lead; `g` charts the first.
  const detailSeries = useMemo(() => {
    const series = detailOpen ? detail.data?.series ?? [] : [];
    const main = new Set(tableLayer.series.map((entry) => entry.id));
    return [...series.filter((entry) => main.has(entry.id)), ...series.filter((entry) => !main.has(entry.id))];
  }, [detail.data?.series, detailOpen, tableLayer.series]);
  const lockedLayer = states.some((state) => state.phase === "locked");

  const hints: PaneHint[] = [
    ...(tableReadable && !detailOpen ? [{ id: "search", key: "/", label: "search", onPress: focusSearch }] : []),
    ...(primaryLink ? [{ id: "des", key: "d", label: "es", title: `Description of ${primaryLink.symbol}`, onPress: () => openTicker(primaryLink) }] : []),
    ...(detailSeries[0] ? [{ id: "graph", key: "g", label: "raph", title: `Chart ${detailSeries[0].name}`, onPress: () => openSeries(detailSeries[0]!) }] : []),
    ...(lockedLayer ? [{ id: "upgrade", key: CLOUD_PLAN_KEY, label: "upgrade", title: "Upgrade to Pro", onPress: () => void upgrade() }] : []),
  ];
  const loadingLayers = states.filter((state) => state.loading);
  // The terminal map does not zoom, so there it only lists such a layer.
  const zoomLayers = nativePaneChrome ? states.filter((state) => state.phase === "zoom") : [];
  const freshness = tableState ? layerFreshness(tableState, now) : null;
  usePaneFooter(WORLD_VENUE_MAP_PANE_ID, () => ({
    info: [
      ...(loadingLayers.length || (pages.loading && !rows.length) || (detailOpen && detail.loading && !detail.data)
        ? [{ id: "loading", parts: [{ text: "loading", tone: "muted" as const }] }] : []),
      ...(pages.loadingMore ? [{ id: "more", parts: [{ text: "loading more", tone: "muted" as const }] }] : []),
      ...(freshness ? [{ id: "fresh", parts: [{ text: freshness.text, tone: freshness.tone }] }] : []),
      ...(zoomLayers.length ? [{ id: "zoom", parts: [{ text: `zoom in for ${zoomLayers.map((state) => state.layer.name).join(", ")}`, tone: "muted" as const }] }] : []),
      ...(pages.error && rows.length ? [{ id: "error", parts: [{ text: pages.error.message, tone: "warning" as const }] }] : []),
    ],
    hints,
  }), [detail.data, detail.loading, detailOpen, freshness?.text, freshness?.tone, hints.map((hint) => hint.id).join(","), loadingLayers.length, pages.error, pages.loading, pages.loadingMore, rows.length, zoomLayers.map((state) => state.layer.id).join(",")]);
  // The table's own layer says it cannot serve in the body; the footer warns about the others.
  const notices = layerNotices(states.filter((state) => state.layer.id !== tableLayer.id || (state.phase !== "unavailable" && state.phase !== "locked")));
  usePaneNoticeFooter({ registrationId: `${WORLD_VENUE_MAP_PANE_ID}:notices`, focused, notices, enabled: !detailOpen });
  usePaneMenuItems(`${WORLD_VENUE_MAP_PANE_ID}:links`, () => [
    ...activeLinks.slice(1).map((link) => ({ id: `des:${tickerLinkKey(link)}`, label: `Open ${tickerLinkKey(link)}`, onSelect: () => openTicker(link) })),
    ...detailSeries.slice(1).map((series) => ({ id: `graph:${series.id}`, label: `Chart ${series.name}`, onSelect: () => openSeries(series) })),
  ], [activeLinks.map(tickerLinkKey).join(","), detailSeries.map((series) => series.id).join(","), openSeries, openTicker]);

  const native = !!nativePaneChrome;
  const [storedSidebarWidth, setStoredSidebarWidth] = usePluginPaneState<number | null>("sidebarWidth", null);
  const [draggedSidebarWidth, setDraggedSidebarWidth] = useState<number | null>(null);
  const horizontal = shouldShowPaneSidebar(Math.max(rows.length, 24), width, height);
  // Wider than the venue list: a layer's table carries a few numeric columns beside the name.
  const defaultSidebarWidth = Math.max(38, Math.min(66, Math.round(width * 0.4))) + (native ? 0 : 1);
  const sidebarWidth = horizontal
    ? getPaneSidebarWidth(width, native, draggedSidebarWidth ?? readStoredPaneSidebarWidth(storedSidebarWidth) ?? defaultSidebarWidth)
    : width;
  const sidebarRange = getPaneSidebarWidthRange(width);
  const listWidth = horizontal && !native ? Math.max(1, sidebarWidth - 1) : sidebarWidth;
  const mapWidth = horizontal ? Math.max(1, width - sidebarWidth) : width;
  // Stacked, the map takes the rows the world needs (plus the header and room to zoom), not half the pane.
  const naturalMapRows = nativePaneChrome ? Math.ceil((width * 145) / 360 / 2.12) + 4 : Math.ceil((width * 145) / 360 / 2.25) + 3;
  const mapSectionHeight = horizontal ? height : Math.max(8, Math.min(Math.floor(height * 0.52), naturalMapRows));
  const tableHeight = horizontal ? height : Math.max(4, height - mapSectionHeight);
  const mapHeight = Math.max(2, mapSectionHeight - 2);

  const layerColumns = pages.pages[0]?.columns?.length ? pages.pages[0].columns : tableLayer.columns;
  const columns = useMemo(() => entityColumns(layerColumns, listWidth), [layerColumns, listWidth]);
  const nowRef = useRef(now);
  nowRef.current = now;
  const renderCell = useCallback((row: GeoEntityRow, column: EntityColumn): DataTableCell => {
    if (column.id === TICKER_COLUMN_ID) {
      const link = row.tickers?.[0];
      return link
        ? { text: formatTickerLinks(row.tickers), value: tickerLinkKey(link), color: colors.textBright, attributes: TextAttributes.BOLD, onMouseDown: () => openTicker(link) }
        : { text: "", value: null };
    }
    const { text, value } = entityCellText(row, column.geo!, nowRef.current);
    if (column.geo?.key === "label") return { text, value, color: colors.textBright };
    if (column.geo && isChangeColumn(column.geo) && typeof value === "number") {
      return { text, value, color: value > 0 ? colors.positive : value < 0 ? colors.negative : colors.text };
    }
    return { text, value, color: column.align === "right" ? colors.text : colors.textDim };
  }, [colors, openTicker]);

  const onScroll = useTableLoadMore(scrollRef, pages.hasMore && !detailOpen, pages.loadMore);
  // A layer that cannot serve has nothing to search and, alone, nothing to switch to: no bar at all.
  const queryBar = !tableReadable && layers.length < 2 ? undefined : (
    <QueryBar
      width={listWidth}
      search={tableReadable ? {
        value: query,
        onChange: setQuery,
        placeholder: "Filter...",
        focused: focused && !detailOpen,
        ...searchProps,
        debounceMs: 200,
        normalizeValue: (value: string) => value.trim(),
      } : undefined}
      view={layers.length > 1 ? {
        value: tableLayer.id,
        options: layers.map((layer) => ({ value: layer.id, label: layer.name })),
        onChange: (id: string) => {
          setTableLayer(id);
          setOpen(null);
        },
        focused: focused && !searchFocused && !detailOpen,
      } : undefined}
    />
  );

  // An entities answer can also say the layer cannot serve right now.
  const pageStatus = pages.pages[0]?.status;
  const unavailableNote = pages.pages[0]?.statusNote ?? tableState?.note ?? tableLayer.statusNote;
  const emptyTitle = tableLocked ? `${tableLayer.name} needs Pro.`
    : !tableReadable || pageStatus === "unavailable" ? `${tableLayer.name} unavailable.`
      : pages.error && !rows.length ? `${tableLayer.name} could not load.`
        : query.trim() ? "No matches." : `No ${tableLayer.name.toLowerCase()} in view.`;
  const emptyHint = tableLocked ? undefined
    : !tableReadable || pageStatus === "unavailable" ? unavailableNote
      : pages.error && !rows.length ? pages.error.message : query.trim() ? "Clear search." : undefined;

  const table = (
    <DataTableStackView<GeoEntityRow, EntityColumn>
      focused={focused && !searchFocused}
      selection={{
        kind: "id",
        selectedId: cursorId,
        getId: (row) => row.id,
        onChange: (id) => {
          setHeaderSubject("entity");
          selectRow(id);
          const row = rows.find((entry) => entry.id === id);
          if (row) setFocus({ key: `select:${tableLayer.id}:${row.id}`, longitude: row.lon, latitude: row.lat });
        },
      }}
      rootWidth={listWidth}
      rootHeight={tableHeight}
      rootBefore={queryBar}
      columns={columns}
      items={rows}
      getItemKey={(row) => row.id}
      renderCell={renderCell}
      selectedTextOverridesCellColor
      sortColumnId={sort.key}
      sortDirection={sort.dir}
      isColumnSortable={(column) => column.id !== TICKER_COLUMN_ID}
      onHeaderClick={(columnId) => {
        if (columnId === TICKER_COLUMN_ID) return;
        setSorts((current) => {
          const previous = current[tableLayer.id] ?? NO_SORT;
          const next: SortState = previous.key === columnId
            ? { key: columnId, dir: previous.dir === "asc" ? "desc" : "asc" }
            : { key: columnId, dir: layerColumns.find((column) => column.key === columnId)?.align === "right" ? "desc" : "asc" };
          return { ...current, [tableLayer.id]: next };
        });
      }}
      scrollRef={scrollRef}
      onBodyScrollActivity={onScroll}
      resetScrollKey={`${tableLayer.id}:${query}:${sort.key}:${sort.dir}`}
      onActivate={(row) => {
        setHeaderSubject("entity");
        selectRow(row.id);
        setOpen({ layer: tableLayer.id, id: row.id });
        setFocus({ key: `open:${tableLayer.id}:${row.id}`, longitude: row.lon, latitude: row.lat, zoom: openZoom(tableLayer) });
      }}
      detailOpen={detailOpen}
      onBack={() => setOpen(null)}
      detailTitle={openRow?.label}
      detailScrollRef={detailScrollRef}
      detailContent={detailOpen ? (
        <EntityDetail
          layer={tableLayer}
          row={openRow}
          detail={detail.data}
          series={detailSeries}
          width={listWidth}
          now={now}
          scrollRef={detailScrollRef}
          onOpenTicker={openTicker}
          onOpenSeries={openSeries}
        />
      ) : null}
      emptyStateTitle={pages.loading && !rows.length && tableReadable ? "Loading..." : emptyTitle}
      emptyStateHint={pages.loading && !rows.length ? undefined : emptyHint}
    />
  );

  const map = (
    <Box flexDirection="column" width={mapWidth} height={mapSectionHeight} overflow="hidden">
      {headerSubject === "venue" && selectedVenue && venueData ? (
        <SelectedVenueHeader venue={selectedVenue} checkedAt={venueData.checkedAt} now={now} width={mapWidth} />
      ) : (
        <SelectedEntityHeader row={headerRow} layer={tableLayer} color={colorFor(tableLayer.id)} now={now} width={mapWidth} />
      )}
      <WorldVenueMap
        venues={venues}
        selectedMic={headerSubject === "venue" ? selectedMic : null}
        width={mapWidth}
        height={mapHeight}
        onSelect={(venue) => {
          setSelectedMic(venue.mic);
          setHeaderSubject("venue");
        }}
        overlay={overlay}
        maxZoom={LAYERED_MAX_ZOOM}
        onSelectGeo={onSelectGeo}
        onViewChange={onViewChange}
        focus={focus}
      />
    </Box>
  );

  if (!layers.length) return <EmptyState title="No layers on." />;

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
