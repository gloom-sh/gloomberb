import { useEffect, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import {
  ChartTableHeader,
  DataTableView,
  formatPercentAxis,
  PaneStatusBody,
  scalarPoint,
  StatGrid,
  staticSeries,
  TickerBadgeList,
  useChartTableSelection,
  usePaneFooter,
  usePaneNoticeFooter,
  type DataTableColumn,
  type StatItem,
} from "../../../components";
import { spanDigits } from "../../../components/chart-table";
import { getTableWidth, hasMeaningfulTableHorizontalOverflow } from "../../../components/ui/table-layout";
import type { CompositeAxisDomain } from "../../../components/chart/composite/types";
import {
  getCachedFredSeries,
  loadCachedFredSeries,
  type FredSeriesData,
  type FredSeriesRequest,
} from "../../../sources/gloomberb-cloud/fred-series";
import { colors } from "../../../theme/colors";
import { Box, Text } from "../../../ui";
import { displayWidth } from "../../../utils/format";
import { useOpenTickerChoice } from "../shared/ticker-choice";
import { resolveFredMapping, projectFredHistory, fredHistoryUnits } from "./fred-series-map";
import { actualColor, timeLabel } from "./calendar-model";
import type { EconEvent } from "./types";

interface EconDetailViewProps {
  event: EconEvent;
  width: number;
  height: number;
  focused: boolean;
}

interface HistoryRow {
  date: string;
  value: number;
  /** Move from the period before, in the value's units; null on the first period. */
  change: number | null;
}

/**
 * The value column is named like the chart's series, so the legend and the
 * table read the same, but it is never wider than the pane leaves: a long
 * event name truncates in the header rather than pushing the right-aligned
 * values off the edge ("162" read "16"). The change column goes next, since a
 * clipped "-0.10pp" would read "-0".
 */
function historyColumns(label: string, width: number): DataTableColumn[] {
  const overflows = (columns: DataTableColumn[]) => hasMeaningfulTableHorizontalOverflow(getTableWidth(columns), width - 1);
  const date: DataTableColumn = { id: "date", label: "Period", width: 12, align: "left" };
  const value: DataTableColumn = { id: "value", label, width: Math.max(10, Math.min(26, displayWidth(label) + 2)), align: "right" };
  while (value.width > 10 && overflows([date, value])) value.width -= 1;
  const columns: DataTableColumn[] = [date, value, { id: "change", label: "Chg", width: 10, align: "right" }];
  return overflows(columns) ? columns.slice(0, 2) : columns;
}

function isPercent(units: string): boolean {
  return units.toLowerCase().includes("percent");
}

function formatHistoryValue(value: number, units: string): string {
  return isPercent(units) ? `${value.toFixed(2)}%` : value.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** A move in a percentage is in points, so it never reads as a relative change. */
function formatHistoryChange(change: number | null, units: string): string {
  if (change == null) return "--";
  const text = isPercent(units)
    ? `${Math.abs(change).toFixed(2)}pp`
    : Math.abs(change).toLocaleString("en-US", { maximumFractionDigits: 1 });
  // A move that rounds to zero carries no sign.
  if (!/[1-9]/.test(text)) return text;
  return `${change > 0 ? "+" : "-"}${text}`;
}

function changeColor(change: number | null, units: string): string {
  if (!/[1-9]/.test(formatHistoryChange(change, units))) return colors.textDim;
  return change! > 0 ? colors.positive : colors.negative;
}

const COMPACT_UNITS = [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const;

/** Levels on the axis, compact, with the decimals the plotted range needs. */
function formatLevelAxis(value: number, domain: CompositeAxisDomain): string {
  const magnitude = Math.max(Math.abs(domain.min), Math.abs(domain.max));
  const [divisor, suffix] = COMPACT_UNITS.find(([unit]) => magnitude >= unit) ?? [1, ""];
  const digits = spanDigits({ min: domain.min / divisor, max: domain.max / divisor });
  return `${(value / divisor).toFixed(digits)}${suffix}`;
}

const historyKey = (row: HistoryRow) => row.date;
const historyDate = (row: HistoryRow) => new Date(`${row.date}T00:00:00Z`);

export function EconDetailView({ event, width, height, focused }: EconDetailViewProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [freshnessWarning, setFreshnessWarning] = useState<string | null>(null);
  const [data, setData] = useState<FredSeriesData | null>(null);
  // Null follows the latest period.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);

  const mapping = useMemo(() => resolveFredMapping(event.event, event.country), [event.event, event.country]);
  const request = useMemo<FredSeriesRequest | null>(() => {
    if (!mapping) return null;
    const fiveYearsAgo = new Date();
    fiveYearsAgo.setFullYear(fiveYearsAgo.getFullYear() - 5);
    const startDate = `${fiveYearsAgo.getFullYear()}-${String(fiveYearsAgo.getMonth() + 1).padStart(2, "0")}-${String(fiveYearsAgo.getDate()).padStart(2, "0")}`;
    return {
      seriesId: mapping.seriesId,
      startDate,
      sortOrder: "asc",
    };
  }, [mapping?.seriesId]);

  useEffect(() => {
    if (!request) {
      setData(null);
      setLoading(false);
      setError(null);
      setFreshnessWarning(null);
      return;
    }

    const cached = getCachedFredSeries(request);
    if (cached) {
      setData(cached.data);
      if (!cached.stale) {
        setLoading(false);
        setError(null);
        setFreshnessWarning(null);
        return;
      }
    } else {
      setData(null);
    }

    setLoading(true);
    setError(null);
    setFreshnessWarning(null);

    loadCachedFredSeries(
      request,
      () => apiClient.getCloudFredSeries(request.seriesId, {
        startDate: request.startDate,
        sortOrder: request.sortOrder,
      }),
    )
      .then((entry) => {
        setData(entry.data);
        setFreshnessWarning(entry.stale
          ? `Cached ${new Date(entry.fetchedAt).toISOString().slice(0, 10)} · refresh failed`
          : null);
      })
      .catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [request]);

  // A stale cache and a failed refresh are limitations of data still on
  // screen, so they sit behind the footer's warning indicator.
  usePaneNoticeFooter({
    registrationId: "econ-detail",
    notices: [freshnessWarning, data && error ? error : null].filter((notice): notice is string => !!notice),
    focused,
  });

  // The related badges open on click; the keyboard reaches them through `t`,
  // which asks which one when there are several.
  const openTickerChoice = useOpenTickerChoice();
  const relatedTickers = useMemo(() => mapping?.relatedTickers ?? [], [mapping]);
  usePaneFooter("econ-detail:related", () => relatedTickers.length > 0 ? {
    hints: [{
      id: "related",
      key: "t",
      label: relatedTickers.length === 1 ? "icker" : "ickers",
      title: relatedTickers.length === 1 ? `Open ${relatedTickers[0]}` : "Open Related Ticker…",
      onPress: () => openTickerChoice(relatedTickers),
    }],
  } : null, [openTickerChoice, relatedTickers]);

  // The stack bar names the event; the detail opens on the release figures,
  // the outcome first so a short detail keeps it.
  const releaseItems: StatItem[] = [
    ...(event.actual ? [{ id: "actual", label: "Actual", value: event.actual, color: actualColor(event.actual, event.forecast) }] : []),
    ...(event.forecast ? [{ id: "forecast", label: "Forecast", value: event.forecast }] : []),
    ...(event.prior ? [{ id: "prior", label: "Prior", value: event.prior }] : []),
    { id: "time", label: "Release", value: timeLabel(event.date) },
  ];

  const projected = useMemo(
    () => data && mapping ? projectFredHistory(data.observations, mapping) : [],
    [data, mapping],
  );
  const units = mapping ? fredHistoryUnits(mapping, data?.info?.units ?? "") : "";
  // Newest first, each with its move from the period before.
  const rows = useMemo<HistoryRow[]>(() => projected
    .map((obs, index) => ({ date: obs.date, value: obs.value, change: index > 0 ? obs.value - projected[index - 1]!.value : null }))
    .reverse(), [projected]);
  const label = event.event;
  const series = useMemo(() => [staticSeries(
    projected.map((obs) => scalarPoint(new Date(`${obs.date}T00:00:00Z`), obs.value)),
    { id: "fred-history", label, color: colors.positive, calendarSpaced: true },
  )], [label, projected]);
  const selectedId = rows.some((row) => row.date === selectedDate) ? selectedDate : rows[0]?.date ?? null;
  const link = useChartTableSelection({
    rows, getId: historyKey, getDate: historyDate, selectedId, onSelect: setSelectedDate, focused,
  });
  const columns = useMemo(() => historyColumns(label, width), [label, width]);

  // A stale cache stays on screen while its refresh runs or fails.
  if (!mapping || ((loading || error) && !data)) {
    return (
      <Box flexDirection="column" width={width} height={height}>
        <StatGrid items={mapping ? [...releaseItems, { id: "series", label: "Series", value: mapping.seriesId }] : releaseItems} width={width} />
        <PaneStatusBody
          loading={!!mapping && loading && !data}
          error={mapping && !loading && !data ? error : null}
          empty={!mapping}
          emptyTitle="No historical data available for this indicator"
          align="center"
        />
      </Box>
    );
  }

  if (!data) return null;

  // The series id names the official publisher's series; units, frequency and
  // adjustment say what the chart and the history below are measured in.
  const statItems: StatItem[] = [
    ...releaseItems,
    { id: "series", label: "Series", value: mapping.seriesId, wide: true,
      detail: [units, data.info?.frequency, data.info?.seasonalAdjustment].filter(Boolean).join(" · ") || undefined },
  ];
  const relatedRows = mapping.relatedTickers.length > 0 ? 1 : 0;
  // The header and the history share every row above the related tickers.
  const bodyHeight = Math.max(1, height - relatedRows);

  return (
    <DataTableView<HistoryRow>
      columns={columns}
      items={rows}
      focused={focused}
      selection={{ kind: "id", selectedId, getId: historyKey, onChange: (id) => setSelectedDate(id) }}
      rootWidth={width}
      rootHeight={height}
      rootBefore={<ChartTableHeader width={width} height={bodyHeight} tableRows={rows.length} tableColumns={columns} figures={statItems}
        chart={projected.length >= 2 ? {
          series,
          formatValue: (value) => formatHistoryValue(value, units),
          formatAxisValue: isPercent(units) ? formatPercentAxis : formatLevelAxis,
          remoteKind: "econ-fred-history",
          ...link,
        } : null} />}
      rootAfter={relatedRows ? (
        <Box paddingX={1} height={1} flexDirection="row" flexShrink={0}>
          <Text fg={colors.textDim}>Related: </Text>
          <TickerBadgeList symbols={mapping.relatedTickers} width={Math.max(8, width - 12)} liveQuote={false} />
        </Box>
      ) : undefined}
      getItemKey={historyKey}
      renderCell={(row, column, _index, state) => {
        const selected = state.selected ? colors.selectedText : undefined;
        return column.id === "date"
          ? { text: row.date, color: selected ?? colors.textDim }
          : column.id === "value"
            ? { text: formatHistoryValue(row.value, units), color: selected ?? (row.value < 0 ? colors.negative : colors.text) }
            : { text: formatHistoryChange(row.change, units), color: selected ?? changeColor(row.change, units) };
      }}
      sortColumnId={null}
      sortDirection="desc"
      emptyStateTitle="No observations."
    />
  );
}
