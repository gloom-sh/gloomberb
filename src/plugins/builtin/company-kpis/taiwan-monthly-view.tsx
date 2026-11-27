import { useCallback, useMemo, useState } from "react";
import { apiClient } from "../../../api-client";
import type { TaiwanBoardRow, TaiwanRevenuePoint } from "../../../api-client/taiwan-revenue";
import {
  CompositeChart,
  DataTableView,
  PaneStatusBody,
  StatGrid,
  type DataTableCell,
  type DataTableColumn,
  type DataTableKeyEvent,
  type StatItem,
} from "../../../components";
import { handleRefreshKey } from "../../../components/data-table/table-pane";
import { useAsyncResource } from "../../../react/async-resource";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, TextAttributes, useRendererHost } from "../../../ui";
import { MISSING_VALUE } from "../../../utils/format";
import { isPlainKey } from "../../../utils/keyboard";
import { logFailure } from "../../../utils/log-failure";
import { usePluginAppActions } from "../../runtime";
import {
  buildBasketRevenueSeries,
  buildMonthlyRevenueSeries,
  fmtSignedPct,
  fmtTwdB,
  stockMonthlyColumns,
  supplierBoardColumns,
} from "./taiwan-monthly-model";

const CHART_PANELS = [{ id: "main" }];

type TaiwanMetricRow = Pick<TaiwanRevenuePoint, "revenueTwdB" | "yoyPct" | "yoyAccelPp" | "momPct" | "ytdYoyPct">;

function signedTone(value: number | null | undefined): "positive" | "negative" {
  return (value ?? 0) >= 0 ? "positive" : "negative";
}

function renderTaiwanMetricCell(
  row: TaiwanMetricRow,
  colId: string,
  colors: ReturnType<typeof useThemeColors>,
): DataTableCell | null {
  switch (colId) {
    case "revenue":
      return { text: fmtTwdB(row.revenueTwdB), value: row.revenueTwdB, color: colors.textBright };
    case "yoy":
      return { text: fmtSignedPct(row.yoyPct), value: row.yoyPct ?? undefined, color: colors[signedTone(row.yoyPct)] };
    case "accel":
      return { text: fmtSignedPct(row.yoyAccelPp, "pp"), value: row.yoyAccelPp ?? undefined, color: colors[signedTone(row.yoyAccelPp)] };
    case "mom":
      return { text: fmtSignedPct(row.momPct), value: row.momPct ?? undefined, color: colors.textDim };
    case "ytdYoy":
      return { text: fmtSignedPct(row.ytdYoyPct), value: row.ytdYoyPct ?? undefined, color: colors.text };
    default:
      return null;
  }
}

function TaiwanMonthlyLayout<TRow>({
  width,
  height,
  focused,
  loading,
  error,
  hasData,
  emptyTitle,
  subject,
  stats,
  series,
  remoteKind,
  columns,
  items,
  sortColumnId,
  emptyStateTitle,
  getId,
  selectedId,
  onSelect,
  onActivate,
  onRootKeyDown,
  renderCell,
}: {
  width: number;
  height: number;
  focused: boolean;
  loading: boolean;
  error: string | null;
  hasData: boolean;
  emptyTitle: string;
  subject: string;
  stats: StatItem[];
  series: Parameters<typeof CompositeChart>[0]["series"];
  remoteKind: string;
  columns: DataTableColumn[];
  items: TRow[];
  sortColumnId: string;
  emptyStateTitle: string;
  getId: (row: TRow) => string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onActivate: (row: TRow) => void;
  onRootKeyDown: (key: DataTableKeyEvent) => boolean;
  renderCell: (row: TRow, col: DataTableColumn) => DataTableCell;
}) {
  const showChart = height >= 20 && series.length > 0;
  const chartHeight = showChart ? Math.min(10, Math.max(7, Math.floor(height * 0.34))) : 0;
  return (
    <PaneStatusBody
      loading={!hasData && loading}
      error={!hasData ? error : null}
      empty={!hasData && !loading && !error}
      emptyTitle={emptyTitle}
      subject={subject}
    >
      {hasData ? (
        <Box flexDirection="column" flexGrow={1} minHeight={0}>
          <StatGrid items={stats} width={width} />
          {showChart ? (
            <CompositeChart
              series={series}
              panels={CHART_PANELS}
              width={width}
              height={chartHeight}
              focused={false}
              navigable={false}
              showLegend
              showTimeAxis
              formatValue={(v) => fmtTwdB(v)}
              formatAxisValue={(v) => `${Math.round(v)}B`}
              remoteKind={remoteKind}
            />
          ) : null}
          <DataTableView<TRow>
            focused={focused}
            rootWidth={width}
            columns={columns}
            items={items}
            sortColumnId={sortColumnId}
            sortDirection="desc"
            emptyStateTitle={emptyStateTitle}
            getItemKey={getId}
            selection={{ kind: "id", selectedId, getId, onChange: onSelect }}
            onActivate={onActivate}
            onRootKeyDown={onRootKeyDown}
            renderCell={renderCell}
          />
        </Box>
      ) : null}
    </PaneStatusBody>
  );
}

export function TaiwanMonthlyStockView({ code, width, height, focused }: { code: string; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const host = useRendererHost();
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const load = useCallback(() => apiClient.getTaiwanStockRevenue(code, 36), [code]);
  const res = useAsyncResource(load);
  const data = res.data;

  const stats = useMemo<StatItem[]>(() => {
    if (!data) return [];
    const { latest, company } = data;
    return [
      { id: "rev", essential: true, label: `Rev (${latest.yearMonth})`, value: fmtTwdB(latest.revenueTwdB) },
      { id: "yoy", essential: true, label: "YoY %", value: fmtSignedPct(latest.yoyPct), detail: `Accel ${fmtSignedPct(latest.yoyAccelPp, "pp")}`, tone: signedTone(latest.yoyPct) },
      { id: "mom", essential: true, label: "MoM %", value: fmtSignedPct(latest.momPct), tone: signedTone(latest.momPct) },
      { id: "ytd-yoy", label: "YTD YoY", value: fmtSignedPct(latest.ytdYoyPct), tone: signedTone(latest.ytdYoyPct) },
      { id: "streak", label: "3M Avg / Streak", value: fmtSignedPct(data.threeMonthAvgYoyPct), detail: `${data.consecutiveYoyGrowthMonths}m +YoY` },
      ...(company.linkedUsTickers.length > 0 ? [{ id: "us-links", label: "US Links", value: company.linkedUsTickers.slice(0, 4).join(", ") }] : []),
    ];
  }, [data]);
  const series = useMemo(
    () => (data ? buildMonthlyRevenueSeries(data.history, { revenue: colors.warning, yoy: colors.positive }) : []),
    [data, colors.warning, colors.positive],
  );
  const columns = useMemo(() => stockMonthlyColumns(width), [width]);
  const openFiling = useCallback((url: string) => {
    void host.openExternal(url).catch(logFailure("taiwan-revenue", "open external filing failed"));
  }, [host]);
  const handleKey = useCallback(
    (key: DataTableKeyEvent) => {
      if (handleRefreshKey(key, res.reload, { stopPropagation: true })) return true;
      if (isPlainKey(key, "o") && data) {
        const row = data.history.find((h) => h.yearMonth === selectedMonth) ?? data.latest;
        if (row?.sourceUrl) openFiling(row.sourceUrl);
        return true;
      }
      return false;
    },
    [data, openFiling, res.reload, selectedMonth],
  );

  return (
    <TaiwanMonthlyLayout<TaiwanRevenuePoint>
      width={width}
      height={height}
      focused={focused}
      loading={res.loading}
      error={res.error}
      hasData={!!data}
      emptyTitle={`No Taiwan monthly revenue history for ${code}.`}
      subject="Taiwan monthly revenue"
      stats={stats}
      series={series}
      remoteKind="taiwan-monthly-revenue"
      columns={columns}
      items={data?.history ?? []}
      sortColumnId="month"
      emptyStateTitle="No monthly revenue records."
      getId={(row) => row.yearMonth}
      selectedId={selectedMonth}
      onSelect={setSelectedMonth}
      onActivate={(row) => openFiling(row.sourceUrl)}
      onRootKeyDown={handleKey}
      renderCell={(row, col) =>
        col.id === "month"
          ? { text: row.yearMonth, color: colors.textBright, attributes: TextAttributes.BOLD }
          : renderTaiwanMetricCell(row, col.id, colors) ?? { text: row.notes ?? MISSING_VALUE, color: colors.textDim }
      }
    />
  );
}

export function TaiwanUsReadthroughView({ usTicker, width, height, focused }: { usTicker: string; width: number; height: number; focused: boolean }) {
  const colors = useThemeColors();
  const { createPaneFromTemplate } = usePluginAppActions();
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const load = useCallback(() => apiClient.getTaiwanUsReadthrough(usTicker, 24), [usTicker]);
  const res = useAsyncResource(load);
  const data = res.data;

  const stats = useMemo<StatItem[]>(() => {
    if (!data) return [];
    return [
      { id: "chain", essential: true, label: `${data.usTicker} TW Chain`, value: `${data.supplierCount} suppliers`, detail: data.latestMonth ?? undefined },
      { id: "agg-rev", essential: true, label: "Aggregate Sales", value: fmtTwdB(data.aggregateRevenueTwdB) },
      { id: "agg-yoy", essential: true, label: "Weighted YoY", value: fmtSignedPct(data.aggregateYoyPct), detail: `Accel ${fmtSignedPct(data.yoyAccelPp, "pp")}`, tone: signedTone(data.aggregateYoyPct) },
      { id: "agg-mom", label: "Weighted MoM", value: fmtSignedPct(data.aggregateMomPct), tone: signedTone(data.aggregateMomPct) },
    ];
  }, [data]);
  const series = useMemo(() => (data ? buildBasketRevenueSeries(data.series, { revenue: colors.warning }) : []), [data, colors.warning]);
  const columns = useMemo(() => supplierBoardColumns(width), [width]);

  return (
    <TaiwanMonthlyLayout<TaiwanBoardRow>
      width={width}
      height={height}
      focused={focused}
      loading={res.loading}
      error={res.error}
      hasData={!!data}
      emptyTitle={`No Taiwan supply-chain monthly revenue mapped for ${usTicker}.`}
      subject="Taiwan supply-chain revenue"
      stats={stats}
      series={series}
      remoteKind="taiwan-supply-chain-revenue"
      columns={columns}
      items={data?.suppliers ?? []}
      sortColumnId="revenue"
      emptyStateTitle="No mapped Taiwan suppliers."
      getId={(row) => row.code}
      selectedId={selectedCode}
      onSelect={setSelectedCode}
      onActivate={(row) => createPaneFromTemplate("company-kpis-pane", { symbol: row.symbol })}
      onRootKeyDown={(key) => handleRefreshKey(key, res.reload, { stopPropagation: true })}
      renderCell={(row, col) =>
        col.id === "code"
          ? { text: row.code, color: colors.textBright, attributes: TextAttributes.BOLD }
          : col.id === "name"
            ? { text: row.nameEn ? `${row.nameEn} (${row.nameZh})` : row.nameZh, color: colors.text }
            : renderTaiwanMetricCell(row, col.id, colors) ?? { text: fmtSignedPct(row.ytdYoyPct), value: row.ytdYoyPct ?? undefined, color: colors.text }
      }
    />
  );
}
