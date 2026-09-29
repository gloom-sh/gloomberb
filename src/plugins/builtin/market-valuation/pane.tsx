import { useMemo } from "react";
import {
  PaneStatusBody, type DataTableCell,
  type DataTableColumn,
  type PaneFooterSegment
} from "../../../components";
import { useAsyncResource } from "../../../react/async-resource";
import { usePaneSettingValue } from "../../../state/app/context";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { formatNumber } from "../../../utils/format";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { usePaneStatusFooter } from "../../../components/layout/pane/status-footer";
import { SeriesListDetail, useSeriesList } from "../shared/series-list-detail";
import { getCachedValuationBundle, loadValuationBundle } from "./client";
import { indicatorSeries, indicatorUnavailableReason, shortZoneLabel, type IndicatorDef, type ValuationRangeId } from "./defs";
import { IndicatorDetail } from "./detail";
import { INDICATORS } from "./indicators";
import { RANGE_OPTIONS, VALUATION_DEFAULTS } from "./settings";
import { formatSigma } from "../shared/trend";
import {
  selectValuationViews,
  type IndicatorViewModel
} from "./view";

const loadBundle = (force: boolean) => loadValuationBundle({ force });

const LIST_WIDTH = 46;
/** The range strip names the key that picks each range: 1, 2 and 3, as the chart's range keys do. */
const RANGE_VIEW_OPTIONS = RANGE_OPTIONS.map((option, index) => ({ ...option, hint: String(index + 1) }));

type ColumnId = "name" | "value" | "zone" | "percentile" | "sigma";
interface Column extends DataTableColumn { id: ColumnId }

interface IndicatorRow {
  indicator: IndicatorDef;
  view: IndicatorViewModel | null;
  error: string | null;
}

function matchesQuery(row: IndicatorRow, query: string): boolean {
  if (!query) return true;
  const haystack = [
    row.indicator.label,
    row.indicator.shortLabel,
    row.indicator.description,
    row.view?.zone?.label,
  ].join(" ").toLowerCase();
  return query.split(/\s+/).every((token) => haystack.includes(token));
}

/** Stacked mode keeps only what fits; the split has a whole column to work with. */
function buildColumns(width: number, stacked: boolean): Column[] {
  const withTrend = stacked && width >= 100;
  return [
    { id: "name", label: "INDICATOR", width: 11, flexGrow: 1, align: "left" },
    { id: "value", label: "VALUE", width: 8, align: "right" },
    { id: "zone", label: "ZONE", width: 11, align: "right" },
    { id: "percentile", label: "RICH", width: 6, align: "right" },
    ...(withTrend
      ? [{ id: "sigma" as const, label: "TREND", width: 8, align: "right" as const }]
      : []),
  ];
}

// Stable table adapters so memoized rows survive pane re-renders.
const indicatorKey = (row: IndicatorRow) => row.indicator.id;
const renderIndicatorCell = (row: IndicatorRow, column: Column) => cellsFor(row)[column.id];

function cellsFor(row: IndicatorRow): Record<ColumnId, DataTableCell> {
  const view = row.view;
  if (!view || view.current.ratio == null || !view.zone) {
    return {
      name: { text: row.indicator.shortLabel, color: colors.textBright },
      value: { text: "--", color: colors.textDim },
      zone: { text: "Unavailable", color: colors.warning },
      percentile: { text: "--", color: colors.textDim },
      sigma: { text: "--", color: colors.textDim },
    };
  }
  return {
    name: { text: view.indicator.shortLabel, color: colors.textBright },
    value: { text: view.indicator.formatValue(view.current.ratio), color: view.zone.color },
    zone: { text: shortZoneLabel(view.zone.id), color: view.zone.color },
    // Restated so a high number always means expensive, whichever way the
    // underlying measure runs, otherwise the column cannot be read down.
    percentile: { text: view.richPercentile == null ? "--" : formatNumber(view.richPercentile, 0), color: colors.text },
    sigma: { text: formatSigma(view.richSigma), color: colors.textMuted },
  };
}

export function MarketValuationPane({ focused, width, height }: PaneProps) {
  const [indicatorId, setIndicatorId] = usePaneSettingValue<string>(
    "indicator",
    VALUATION_DEFAULTS.indicator,
  );
  const [range, setRange] = usePaneSettingValue<ValuationRangeId>("range", VALUATION_DEFAULTS.range);
  const resource = useAsyncResource(loadBundle, { initialData: () => getCachedValuationBundle() });
  const { data: bundle, load, reload: refresh, updatedAt: lastUpdated } = resource;
  useAutoRefresh(lastUpdated, load);

  const views = useMemo(
    () => (bundle ? selectValuationViews(bundle, range) : []),
    [bundle, range],
  );
  const rows = useMemo<IndicatorRow[]>(() => bundle ? INDICATORS.flatMap((indicator) => {
    const view = views.find((entry) => entry.indicator.id === indicator.id) ?? null;
    const error = indicatorUnavailableReason(indicator)
      ?? bundle.errors.find((entry) => [indicator.label, ...indicatorSeries(indicator).map((def) => def.key)]
        .some((prefix) => entry.startsWith(`${prefix}:`))) ?? null;
    return view || error ? [{ indicator, view, error }] : [];
  }) : [], [bundle, views]);
  const list = useSeriesList({
    focused,
    items: rows,
    getId: indicatorKey,
    matchesQuery,
    selectedId: indicatorId,
    onSelect: setIndicatorId,
    reload: refresh,
    range: { value: range, options: RANGE_VIEW_OPTIONS, onChange: setRange },
  });
  const { selected } = list;
  const selectedView = selected?.view;

  const basisErrors = new Set(INDICATORS.flatMap((indicator) => {
    const reason = indicatorUnavailableReason(indicator);
    return reason ? [`${indicator.label}: ${reason}`] : [];
  }));
  const sourceError = bundle?.errors.find((entry) => !basisErrors.has(entry));
  const unavailableCount = bundle?.errors.filter((entry) => basisErrors.has(entry)).length ?? 0;
  const bodyError = resource.error ?? sourceError ?? null;
  const error = bodyError ?? selected?.error
    ?? (unavailableCount ? `${unavailableCount} unavailable` : null);
  const footerInfo = useMemo<PaneFooterSegment[]>(() => {
    if (!selectedView) return [];
    const info: PaneFooterSegment[] = [
      { id: "as-of", parts: [{ text: `as of ${selectedView.asOf}`, tone: "muted" }] },
      ...(width >= 80 ? [{ id: "delayed", parts: [{ text: "delayed", tone: "muted" as const }] }] : []),
    ];
    if (selectedView.observationStale) {
      info.push({ id: "stale", parts: [{ text: "STALE", tone: "warning", bold: true }] });
    }
    return info;
  }, [selectedView, width]);

  usePaneStatusFooter({
    registrationId: "market-valuation",
    loading: resource.loading,
    error: error && !selectedView ? "Unavailable" : error,
    info: footerInfo,
  });

  if (!bundle && resource.error === null) {
    return (
      <PaneStatusBody loading align="center" width={width} height={height} loadingLabel="Loading market valuation..." />
    );
  }

  if (!selected) {
    return (
      <PaneStatusBody
        error={error}
        errorTitle="Market valuation unavailable."
        empty
        emptyTitle="Market valuation unavailable."
      />
    );
  }

  return (
    <SeriesListDetail
      list={list}
      width={width}
      height={height}
      focused={focused}
      listWidth={LIST_WIDTH}
      searchPlaceholder="filter indicators"
      columns={buildColumns}
      rows={list.visible}
      getRowId={indicatorKey}
      renderCell={renderIndicatorCell}
      emptyStateTitle={list.normalizedQuery ? "No indicator matches." : error ?? "No indicators."}
      renderDetail={(size) => selectedView ? <IndicatorDetail view={selectedView} {...size} /> : (
        <PaneStatusBody
          error={selected.error ?? "No data."}
          errorTitle={`${selected.indicator.label} unavailable`}
        />
      )}
    />
  );
}
