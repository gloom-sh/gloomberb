import { dayCell } from "../../../components/ui/day-cell";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { ChartTableHeader, DataTableView, EmptyState, PaneStatusBody, QueryBar, scalarPoint, spanAxisFormatter, staticSeries,
  useChartTableSelection, usePaneFooter, usePaneNoticeFooter, usePaneTicker, type DataTableCell, type DataTableColumn,
  type StatItem } from "../../../components";
import { usePaneRefreshKey } from "../../../components/data-table/table-pane";
import { instrumentFromTicker } from "../../../market-data/request-types";
import { usePaneSettingValue, usePluginPaneState } from "../../../public/react";
import { useAsyncResource } from "../../../react/async-resource";
import { useCloudDisplayScope } from "../../../api-client/plan-access";
import { useAutoRefresh } from "../../../react/auto-refresh";
import { blendHex } from "../../../theme/color-utils";
import { useThemeColors } from "../../../theme/theme-context";
import type { PaneProps } from "../../../types/plugin";
import { Box } from "../../../ui";
import { MISSING_VALUE, formatCurrency, formatPercentileRank } from "../../../utils/format";
import { useAssetData } from "../../runtime";
import { loadPeBandInputs } from "./client";
import { formatEpsFx, formatPerShare, perShareDigits, projectPeBand, type PeBandModel, type PeBandRow } from "./model";

export const LOOKBACK_OPTIONS = [{ value: "5", label: "5Y" }, { value: "10", label: "10Y" }, { value: "0", label: "Max" }];

const multiple = (value: number | null | undefined) => value == null ? MISSING_VALUE : `${value.toFixed(1)}x`;
function pct(value: number | null): string {
  if (value == null) return MISSING_VALUE;
  const fixed = (value * 100).toFixed(1);
  return /[1-9]/.test(fixed) ? `${value > 0 ? "+" : ""}${fixed}%` : "0.0%";
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const periodLabel = (row: Pick<PeBandRow, "basis" | "periodEnd">) =>
  `${row.basis === "annual" ? "FY" : "TTM"} ${MONTHS[Number(row.periodEnd.slice(5, 7)) - 1]} ${row.periodEnd.slice(0, 4)}`;

/** With EPS converted from another currency, the table keeps the reported figure and adds the FX close it was converted at. */
function tableColumns(showFx: boolean): DataTableColumn[] {
  return [
    { id: "period", label: "Period", width: 13, align: "left" },
    { id: "known", label: "Known", width: 11, align: "left" },
    { id: "eps", label: "EPS", width: showFx ? 14 : 9, align: "right" },
    ...(showFx ? [{ id: "fx", label: "Period-end FX", width: 17, align: "right" as const }] : []),
    { id: "yoy", label: "YoY", width: 8, align: "right", omitWhenEmpty: true },
    { id: "price", label: "Price", width: 10, align: "right" },
    { id: "pe", label: "P/E", width: 7, align: "right" },
  ];
}

const rowKey = (row: PeBandRow) => `${row.basis}:${row.periodEnd}`;

function renderCell(row: PeBandRow, column: DataTableColumn, colors: ReturnType<typeof useThemeColors>, fxTarget?: string): DataTableCell {
  switch (column.id) {
    case "period": return { text: periodLabel(row) };
    // A figure with no publication date on record steps at its period end.
    case "known": return row.dated ? dayCell(row.knownAt)
      : { text: "period end", color: colors.textMuted };
    case "eps": return { text: row.eps == null ? MISSING_VALUE : `${formatPerShare(row.eps)}${fxTarget && row.currency ? ` ${row.currency}` : ""}`, value: row.eps,
      color: row.eps != null && row.eps <= 0 ? colors.negative : undefined };
    case "yoy": return { text: pct(row.yoy), value: row.yoy == null ? null : row.yoy * 100,
      color: row.yoy == null || Math.abs(row.yoy) < 0.0005 ? undefined : row.yoy > 0 ? colors.positive : colors.negative };
    case "fx": {
      return { text: row.fx && row.currency && fxTarget ? formatEpsFx(row.currency, fxTarget, row.fx.rate) : MISSING_VALUE, value: row.fx?.rate };
    }
    case "price": return { text: row.price == null ? MISSING_VALUE : formatPerShare(row.price), value: row.price };
    default: return { text: multiple(row.pe), value: row.pe };
  }
}

function chartSeries(model: PeBandModel, colors: ReturnType<typeof useThemeColors>) {
  const last = model.multiples.length - 1;
  return [
    // Cheap multiples toward the positive colour, rich ones toward the negative, both faded so the price stays on top.
    ...model.multiples.map((value, index) => staticSeries(
      // Values past the ceiling leave the chart, so a far line cannot stretch the axis away from the price.
      model.points.map((week) => {
        const band = week.eps == null ? null : week.eps * value;
        return scalarPoint(week.date, band != null && model.bandCeiling != null && band > model.bandCeiling ? null : band);
      }),
      { id: `x${value}`, label: `${value}x`, calendarSpaced: true, color: blendHex(colors.bg,
        blendHex(colors.positive, colors.negative, last > 0 ? index / last : 0.5), 0.75) },
    )),
    staticSeries(model.points.map((week) => scalarPoint(week.date, week.close)), { id: "price", label: "Price", color: colors.textBright, calendarSpaced: true }),
  ];
}

export function PeBandPane({ width, height, focused }: PaneProps) {
  const colors = useThemeColors();
  const marketData = useAssetData();
  const { symbol, ticker, error: identityError } = usePaneTicker();
  const [lookback, setLookback] = usePaneSettingValue("lookbackYears", "10");
  const [selectedId, setSelectedId] = usePluginPaneState<string | null>("selectedRow", null);
  const instrument = instrumentFromTicker(ticker, symbol);
  const instrumentKey = JSON.stringify(instrument);
  const controller = useRef<AbortController | null>(null);
  const loader = useCallback(async (force: boolean) => {
    controller.current?.abort();
    controller.current = new AbortController();
    const inputs = await loadPeBandInputs({ instrument: instrument!, forceRefresh: force, signal: controller.current.signal }, marketData!);
    if (!inputs.financials && inputs.error) throw new Error(inputs.error);
    return inputs;
  }, [instrumentKey, marketData]);
  const scope = useCloudDisplayScope();
  const inputs = useAsyncResource(scope && instrument && marketData ? loader : null, {
    savedCopy: scope && marketData && !instrument?.instrument ? { key: ["pe-band", scope, marketData.id, instrumentKey] } : null,
  });
  useEffect(() => () => controller.current?.abort(), [loader]);
  useAutoRefresh(inputs.updatedAt, inputs.load);
  usePaneRefreshKey(() => { inputs.reload(); }, { focused });

  const lookbackYears = Number(lookback);
  const model = useMemo(() => inputs.data
    ? projectPeBand(inputs.data.financials, inputs.data.history, { symbol: symbol ?? "", exchange: instrument?.exchange, lookbackYears: Number.isFinite(lookbackYears) ? lookbackYears : 10,
      reports: inputs.data.reports, fx: inputs.data.fx, fxError: inputs.data.fxError, daily: inputs.data.daily })
    : null, [inputs.data, lookbackYears, symbol, instrument?.exchange]);
  const rows = model?.rows ?? [];
  const conversion = model?.conversion ?? null;
  const showFx = !!conversion || rows.some((row) => row.fx);
  const columns = useMemo(() => tableColumns(showFx), [showFx]);
  const series = useMemo(() => model && !model.error ? chartSeries(model, colors) : [], [model, colors]);
  const currency = model?.currency ?? undefined;
  const scoped = !!inputs.data?.financials?.statementScope;
  const firstWeek = model?.weeks[0]?.date;
  const lastWeek = model?.weeks.at(-1)?.date;
  const sampleStart = model?.sample?.start;
  // The window the percentile ranks within: the lookback, or the shorter run of EPS on record.
  const windowLabel = !sampleStart || !lastWeek ? undefined
    : lookbackYears > 0 && (lastWeek.getTime() - sampleStart.getTime()) > (lookbackYears - 0.1) * 365.25 * 86_400_000
      ? `${lookbackYears}Y` : `since ${sampleStart.getUTCFullYear()}`;

  const selected = rows.some((row) => rowKey(row) === selectedId) ? selectedId : rows[0] ? rowKey(rows[0]) : null;
  const rowDate = useCallback((row: PeBandRow) => row.priceAt !== undefined ? row.priceAt : (firstWeek && row.knownAt >= firstWeek ? row.knownAt : null), [firstWeek?.getTime()]);
  const link = useChartTableSelection({ rows, getId: rowKey, getDate: rowDate, selectedId: selected, onSelect: setSelectedId, focused });

  const undatedNotice = model?.undated
    ? `${model.undated} EPS figure${model.undated === 1 ? " has" : "s have"} no publication date on record and step${model.undated === 1 ? "s" : ""} at the period end.` : null;
  const unavailableNotice = model?.unavailable
    ? `${model.unavailable} trailing EPS sum${model.unavailable === 1 ? " is" : "s are"} unavailable because a quarter's EPS is not reported; the previous figure stays in force.` : null;
  usePaneNoticeFooter({ registrationId: "pe-band-notices", focused, notices: [...new Set([identityError, inputs.error, inputs.data?.historyError,
    model?.notice, model && !model.error && inputs.data?.fxError ? `EPS in another currency is not converted: ${inputs.data.fxError}.` : null,
    unavailableNotice, undatedNotice].filter((value): value is string => !!value))] });
  usePaneFooter("pe-band", () => ({ info: [
    ...(inputs.loading ? [{ id: "loading", parts: [{ text: "loading statements", tone: "muted" as const }] }] : []),
    ...(inputs.data?.stale ? [{ id: "stale", parts: [{ text: "stale", tone: "warning" as const }] }] : []),
    ...(currency && model?.weeks.length ? [{ id: "units", parts: [{ text: `weekly closes, ${currency}`, tone: "muted" as const }] }] : []),
  ] }), [inputs.loading, inputs.data?.stale, currency, model?.weeks.length]);

  const figures = useMemo((): StatItem[] => {
    if (!model?.current || model.error) return [];
    const { current, range } = model;
    const step = current.step;
    // Converted EPS says what it was converted from, and at which close.
    const converted = step?.eps != null && conversion && currency && step.currency === conversion.currency
      ? ` · from ${conversion.currency} ${formatPerShare(step.eps)} at ${formatEpsFx(conversion.currency, currency, conversion.latest.rate)}` : "";
    return [
      { id: "pe", label: "P/E", value: multiple(current.pe),
        detail: current.pe != null ? formatPercentileRank(current.percentile, windowLabel) : current.eps != null ? "EPS not positive" : "EPS unavailable" },
      { id: "median", label: "Median P/E", value: multiple(range?.median), detail: range ? `${multiple(range.min)} to ${multiple(range.max)}` : undefined },
      { id: "eps", label: "EPS", value: current.eps == null ? MISSING_VALUE : formatCurrency(current.eps, currency, perShareDigits(current.eps)),
        detail: step ? `${periodLabel(step)}${converted}` : undefined },
      { id: "price", label: "Price", value: formatCurrency(current.price, currency, perShareDigits(current.price)) },
    ];
  }, [model, windowLabel, currency, conversion]);

  const formatPrice = useCallback((value: number) => formatCurrency(value, currency, perShareDigits(value)), [currency]);
  const formatAxis = useMemo(() => spanAxisFormatter((value, digits) => formatCurrency(value, currency, Math.max(2, digits)), 2), [currency]);
  const query = <QueryBar width={width} filters={[{ id: "lookback", label: "Lookback", value: String(lookback), options: LOOKBACK_OPTIONS, onChange: setLookback }]} />;

  if (!symbol) return <EmptyState title="Choose a ticker." />;
  return <Box width={width} height={height} flexDirection="column" overflow="hidden">
    <PaneStatusBody subject="P/E band" loading={inputs.loading && !model} error={!model ? inputs.error ?? identityError ?? null : model.error} empty={false}>
      {model && !model.error ? <DataTableView<PeBandRow> focused={focused} columns={columns} items={rows} rootWidth={width} rootHeight={height}
        getItemKey={rowKey} emptyStateTitle="No trailing EPS in this window." sortColumnId={null} sortDirection="desc" resetScrollKey={symbol}
        selection={{ kind: "id", selectedId: selected, getId: rowKey, onChange: (id) => setSelectedId(id) }}
        selectedTextOverridesCellColor
        getExportMetadata={() => [["symbol", model.symbol], ["currency", model.currency ?? ""],
          ["units", scoped ? "EPS and price in the listing currency; P/E at the first eligible close on or after EPS publication" : showFx
            ? `EPS as reported; period-end FX to ${model.currency ?? ""}; P/E at the close of the day the EPS became known`
            : "EPS and price in the listing currency; P/E at the close of the day the EPS became known"]]}
        renderCell={(row, column) => renderCell(row, column, colors, showFx ? currency : undefined)}
        rootBefore={<ChartTableHeader width={width} height={height} tableRows={rows.length} tableColumns={columns} query={query} figures={figures}
          chart={scoped || model.weeks.length >= 2 ? { series, allowSinglePoint: scoped, formatValue: formatPrice, formatAxisValue: formatAxis, remoteKind: "pe-band", ...link } : null} />} />
        : null}
    </PaneStatusBody>
  </Box>;
}
